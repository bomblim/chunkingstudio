"""벡터 저장소 어댑터.

- milvus: pymilvus MilvusClient. 컬렉션 스키마는 아래 FIELDS 참고.
- memory: 개발용. data/vectors/ 아래 JSON 파일에 저장하고 전수 비교로 검색한다(소규모 테스트 전용).

청크 원문은 `text` 필드에 그대로 저장하고, 실제로 임베딩한 텍스트는 `embed_text`에 따로 둔다.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .config import settings
from .ids import is_uuid
from .models import VectorStore

# Milvus VARCHAR 최대 길이(바이트). 한글은 UTF-8로 3바이트라 약 2만 자까지 들어간다.
VARCHAR_MAX = 65535
SCALAR_FIELDS = ("chunk_id", "run_id", "document_id", "title", "section_path", "text", "embed_text", "metadata")
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,254}$")


class VectorStoreError(Exception):
    pass


@dataclass
class SearchHit:
    id: str
    score: float
    fields: dict[str, Any]


class Store(Protocol):
    def health(self) -> dict[str, Any]: ...
    def list_collections(self) -> list[str]: ...
    def has_collection(self, name: str) -> bool: ...
    def create_collection(self, name: str, dim: int, metric: str) -> None: ...
    def drop_collection(self, name: str) -> None: ...
    def describe(self, name: str) -> dict[str, Any]: ...
    def insert(self, name: str, rows: list[dict[str, Any]]) -> int: ...
    def delete_by_run(self, name: str, run_id: str) -> None: ...
    def delete_by_document(self, name: str, document_id: str) -> None: ...
    def search(self, name: str, vector: list[float], top_k: int, filter: str = "",
               principals: list[str] | None = None) -> list[SearchHit]: ...
    def count(self, name: str) -> int: ...
    def browse(self, name: str, document_id: str | None, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]: ...


def _type_name(t: Any) -> str:
    """pymilvus 필드 타입(DataType enum 또는 이름 문자열)을 이름으로"""
    name = getattr(t, "name", None)
    return (name or str(t or "")).upper()


def _uuid_literal(value: str) -> str:
    """필터식에 넣을 ID. UUID 형식만 허용해 필터식 주입을 막는다."""
    if not is_uuid(value):
        raise VectorStoreError(f"잘못된 ID 형식입니다: {value!r}")
    return value


def validate_collection_name(name: str) -> None:
    if not _NAME_RE.match(name):
        raise VectorStoreError("컬렉션 이름은 영문자/밑줄로 시작하고 영문자·숫자·밑줄만 쓸 수 있습니다 (최대 255자)")


def clip_utf8(text: str, max_bytes: int = VARCHAR_MAX - 16) -> tuple[str, bool]:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False
    return raw[:max_bytes].decode("utf-8", errors="ignore"), True


def permission_expr(principals: list[str] | None) -> str:
    """Milvus 권한 필터식. principals=None이면 필터 없음, []이면 공개 청크만.

    청크 metadata의 public(권한 목록이 비어 제한 없음) 또는 permissions에 주체가 하나라도 있으면 열람 가능.
    주체 문자열은 projects.validate_principal로 검증된 값만 들어온다(따옴표·대괄호 불가).
    """
    if principals is None:
        return ""
    public = 'metadata["public"] == true'
    if not principals:
        return public
    return f'({public} or json_contains_any(metadata["permissions"], {json.dumps(principals, ensure_ascii=False)}))'


def combine_filters(*exprs: str) -> str:
    parts = [e.strip() for e in exprs if e and e.strip()]
    return " and ".join(f"({p})" for p in parts)


def can_access(metadata: dict[str, Any] | None, principals: list[str] | None) -> bool:
    if principals is None:
        return True
    m = metadata or {}
    return bool(m.get("public")) or bool(set(m.get("permissions") or []) & set(principals))


def open_store(store: VectorStore) -> Store:
    if not store.enabled:
        raise VectorStoreError(f"비활성화된 저장소입니다: {store.name}")
    if store.kind == "milvus":
        return MilvusStore(store)
    if store.kind == "memory":
        return MemoryStore(store)
    raise VectorStoreError(f"지원하지 않는 저장소 종류: {store.kind}")


# ------------------------------------------------------------------ Milvus
def tls_kwargs(uri: str, ca_path: str = "", server_name: str = "") -> dict[str, Any]:
    """https:// URI면 TLS(gRPC secure channel)로 접속한다.

    - ca_path: 사설 CA로 발급한 인증서를 신뢰하기 위한 CA(PEM) 파일. 비우면 gRPC 내장 공인 CA 목록만 신뢰한다.
    - server_name: 인증서 검증에 쓸 호스트명(URI 호스트와 인증서 SAN이 다를 때).
    """
    ca_path, server_name = (ca_path or "").strip(), (server_name or "").strip()
    if not uri.lower().startswith("https://"):
        if ca_path or server_name:
            raise VectorStoreError("TLS 설정(CA·서버 이름)은 URI가 https:// 일 때만 사용할 수 있습니다")
        return {}
    kwargs: dict[str, Any] = {"secure": True}
    if ca_path:
        if not os.path.isfile(ca_path):
            raise VectorStoreError(f"CA 인증서 파일이 없습니다: {ca_path}")
        kwargs["server_pem_path"] = ca_path
    if server_name:
        kwargs["server_name"] = server_name
    return kwargs


_CLIENTS: dict[str, tuple[tuple, Any]] = {}  # 저장소 id -> (접속 설정 fingerprint, MilvusClient)
_CLIENTS_LOCK = threading.Lock()


def _close_quietly(client: Any) -> None:
    try:
        client.close()
    except Exception:  # pragma: no cover
        pass


class MilvusStore:
    def __init__(self, cfg: VectorStore):
        try:
            from pymilvus import MilvusClient
        except ImportError as exc:  # pragma: no cover
            raise VectorStoreError("pymilvus가 설치되어 있지 않습니다") from exc
        token = ""
        if cfg.token_env:
            token = os.environ.get(cfg.token_env, "")
            if not token:
                raise VectorStoreError(f"환경변수 {cfg.token_env}가 비어 있습니다")
        uri = cfg.uri or "http://localhost:19530"
        tls = tls_kwargs(uri, cfg.tls_ca_path, cfg.tls_server_name)
        # pymilvus는 공유 연결을 "주소|토큰"으로만 구분해 http/https·CA·서버 이름이 달라도 기존 연결을 재사용한다.
        # 그래서 저장소마다 전용(dedicated) 연결을 만들고, 접속 설정이 바뀌면 새로 연결한다.
        ca_mtime = os.path.getmtime(tls["server_pem_path"]) if "server_pem_path" in tls else 0.0
        fingerprint = (uri, token, cfg.db_name or "", tuple(sorted(tls.items())), ca_mtime)
        store_id = getattr(cfg, "id", None)
        with _CLIENTS_LOCK:
            cached = _CLIENTS.get(store_id) if store_id is not None else None
            if cached and cached[0] == fingerprint:
                self.client = cached[1]
                return
        try:
            self.client = MilvusClient(uri=uri, token=token, db_name=cfg.db_name or "", timeout=10,
                                       dedicated=True, **tls)
        except Exception as exc:
            hint = ""
            if uri.lower().startswith("https://"):
                hint = (" — TLS 접속이면 인증서 검증 실패일 수 있습니다: 사설 CA면 'CA 인증서 경로'를, "
                        "인증서 이름과 URI 호스트가 다르면 '인증서 서버 이름'을 확인하세요")
            raise VectorStoreError(f"Milvus 연결 실패({cfg.uri}): {exc}{hint}") from exc
        if store_id is not None:
            with _CLIENTS_LOCK:
                old = _CLIENTS.get(store_id)
                _CLIENTS[store_id] = (fingerprint, self.client)
            if old:
                _close_quietly(old[1])

    def _call(self, fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except VectorStoreError:
            raise
        except Exception as exc:
            raise VectorStoreError(f"Milvus 오류: {exc}") from exc

    def health(self) -> dict[str, Any]:
        version = ""
        try:
            version = self.client.get_server_version()
        except Exception:
            pass
        return {"server_version": version, "collections": self.list_collections()}

    def list_collections(self) -> list[str]:
        return list(self._call(self.client.list_collections))

    def has_collection(self, name: str) -> bool:
        return bool(self._call(self.client.has_collection, name))

    def create_collection(self, name: str, dim: int, metric: str) -> None:
        from pymilvus import DataType, MilvusClient

        schema = MilvusClient.create_schema(auto_id=False, enable_dynamic_field=True,
                                            description="Chunking Studio chunks")
        schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=128)
        schema.add_field("vector", DataType.FLOAT_VECTOR, dim=dim)
        schema.add_field("chunk_id", DataType.VARCHAR, max_length=64)
        schema.add_field("run_id", DataType.VARCHAR, max_length=64)  # UUID
        schema.add_field("document_id", DataType.VARCHAR, max_length=64)
        schema.add_field("title", DataType.VARCHAR, max_length=2048)
        schema.add_field("section_path", DataType.VARCHAR, max_length=4096)
        schema.add_field("text", DataType.VARCHAR, max_length=VARCHAR_MAX)
        schema.add_field("embed_text", DataType.VARCHAR, max_length=VARCHAR_MAX)
        schema.add_field("metadata", DataType.JSON)
        index = self.client.prepare_index_params()
        index.add_index(field_name="vector", index_type="AUTOINDEX", metric_type=metric)
        self._call(self.client.create_collection, collection_name=name, schema=schema, index_params=index)
        self._call(self.client.load_collection, name)

    def drop_collection(self, name: str) -> None:
        self._call(self.client.drop_collection, name)

    def describe(self, name: str) -> dict[str, Any]:
        info = self._call(self.client.describe_collection, name)
        dim = None
        metric = None
        for f in info.get("fields", []):
            if f.get("name") == "vector":
                dim = (f.get("params") or {}).get("dim")
        try:
            idx = self.client.describe_index(name, index_name="vector")
            metric = idx.get("metric_type")
        except Exception:
            pass
        run_field = next((f for f in info.get("fields", []) if f.get("name") == "run_id"), {})
        return {"dimension": int(dim) if dim else None, "metric": metric,
                "fields": [f.get("name") for f in info.get("fields", [])],
                # UUID 전환 이전에 만든 컬렉션은 run_id·document_id가 정수(INT64)라 새 ID를 넣을 수 없다
                "legacy_int_ids": _type_name(run_field.get("type")) == "INT64"}

    def insert(self, name: str, rows: list[dict[str, Any]]) -> int:
        total = 0
        for i in range(0, len(rows), 500):
            res = self._call(self.client.insert, collection_name=name, data=rows[i : i + 500])
            total += int(res.get("insert_count", 0))
        self._call(self.client.flush, name)
        return total

    def delete_by_run(self, name: str, run_id: str) -> None:
        self._call(self.client.delete, collection_name=name, filter=f'run_id == "{_uuid_literal(run_id)}"')

    def delete_by_document(self, name: str, document_id: str) -> None:
        self._call(self.client.delete, collection_name=name, filter=f'document_id == "{_uuid_literal(document_id)}"')

    def search(self, name: str, vector: list[float], top_k: int, filter: str = "",
               principals: list[str] | None = None) -> list[SearchHit]:
        self._call(self.client.load_collection, name)
        expr = combine_filters(filter, permission_expr(principals))
        res = self._call(self.client.search, collection_name=name, data=[vector], limit=top_k, filter=expr,
                         output_fields=list(SCALAR_FIELDS))
        hits = []
        for h in res[0] if res else []:
            entity = h.get("entity") or {}
            hits.append(SearchHit(id=str(h.get("id")), score=float(h.get("distance", 0.0)), fields=dict(entity)))
        return hits

    def count(self, name: str) -> int:
        stats = self._call(self.client.get_collection_stats, name)
        return int(stats.get("row_count", 0))

    def browse(self, name: str, document_id: str | None, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
        """질의 없이 저장된 청크를 훑어본다(저장 순서와 무관, 페이지 단위)."""
        self._call(self.client.load_collection, name)
        legacy = self.describe(name).get("legacy_int_ids")
        if document_id:
            if legacy:
                raise VectorStoreError("정수 ID로 적재된 이전 형식 컬렉션은 문서별로 걸러 볼 수 없습니다. 비우고 다시 적재하세요")
            expr = f'document_id == "{_uuid_literal(document_id)}"'
        else:
            expr = 'id != ""'
        total = self._call(self.client.query, collection_name=name, filter=expr, output_fields=["count(*)"])
        total_n = int(total[0].get("count(*)", 0)) if total else 0
        rows = self._call(self.client.query, collection_name=name, filter=expr,
                          output_fields=["id", *SCALAR_FIELDS], limit=limit, offset=offset)
        return [dict(r) for r in rows], total_n


# ------------------------------------------------------------------ Memory (개발용)
class MemoryStore:
    def __init__(self, cfg: VectorStore):
        self.dir = settings.data_dir / "vectors" / f"store_{cfg.id}"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        validate_collection_name(name)
        return self.dir / f"{name}.json"

    def _load(self, name: str) -> dict[str, Any]:
        p = self._path(name)
        if not p.exists():
            raise VectorStoreError(f"컬렉션이 없습니다: {name}")
        return json.loads(p.read_text(encoding="utf-8"))

    def _save(self, name: str, data: dict[str, Any]) -> None:
        tmp = self._path(name).with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path(name))

    def health(self) -> dict[str, Any]:
        return {"server_version": "memory", "collections": self.list_collections(), "path": str(self.dir)}

    def list_collections(self) -> list[str]:
        return sorted(p.stem for p in self.dir.glob("*.json"))

    def has_collection(self, name: str) -> bool:
        return self._path(name).exists()

    def create_collection(self, name: str, dim: int, metric: str) -> None:
        self._save(name, {"dimension": dim, "metric": metric, "rows": {}})

    def drop_collection(self, name: str) -> None:
        self._path(name).unlink(missing_ok=True)

    def describe(self, name: str) -> dict[str, Any]:
        d = self._load(name)
        return {"dimension": d["dimension"], "metric": d["metric"], "fields": ["id", "vector", *SCALAR_FIELDS]}

    def insert(self, name: str, rows: list[dict[str, Any]]) -> int:
        d = self._load(name)
        for r in rows:
            if len(r["vector"]) != d["dimension"]:
                raise VectorStoreError(f"차원 불일치: 컬렉션 {d['dimension']} / 입력 {len(r['vector'])}")
            d["rows"][r["id"]] = r
        self._save(name, d)
        return len(rows)

    def delete_by_run(self, name: str, run_id: str) -> None:
        d = self._load(name)
        d["rows"] = {k: v for k, v in d["rows"].items() if v.get("run_id") != run_id}
        self._save(name, d)

    def delete_by_document(self, name: str, document_id: str) -> None:
        d = self._load(name)
        d["rows"] = {k: v for k, v in d["rows"].items() if v.get("document_id") != document_id}
        self._save(name, d)

    def search(self, name: str, vector: list[float], top_k: int, filter: str = "",
               principals: list[str] | None = None) -> list[SearchHit]:
        if filter.strip():
            raise VectorStoreError("메모리 저장소는 필터식을 지원하지 않습니다 (Milvus에서 사용하세요). 권한 필터는 지원합니다")
        d = self._load(name)
        metric = d["metric"]
        scored = []
        for r in d["rows"].values():
            if not can_access(r.get("metadata"), principals):
                continue
            v = r["vector"]
            if metric == "L2":
                s = math.sqrt(sum((a - b) ** 2 for a, b in zip(v, vector, strict=True)))
            else:
                dot = sum(a * b for a, b in zip(v, vector, strict=True))
                if metric == "COSINE":
                    na = math.sqrt(sum(a * a for a in v)) or 1.0
                    nb = math.sqrt(sum(b * b for b in vector)) or 1.0
                    dot /= na * nb
                s = dot
            scored.append((s, r))
        scored.sort(key=lambda x: x[0], reverse=metric != "L2")
        return [SearchHit(id=r["id"], score=s, fields={k: r.get(k) for k in SCALAR_FIELDS}) for s, r in scored[:top_k]]

    def count(self, name: str) -> int:
        return len(self._load(name)["rows"])

    def browse(self, name: str, document_id: str | None, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
        rows = [r for r in self._load(name)["rows"].values() if not document_id or r.get("document_id") == document_id]
        rows.sort(key=lambda r: r.get("id", ""))
        page = [{k: r.get(k) for k in ("id", *SCALAR_FIELDS)} for r in rows[offset:offset + limit]]
        return page, len(rows)


def timed(fn, *args, **kwargs) -> tuple[Any, int]:
    started = time.monotonic()
    out = fn(*args, **kwargs)
    return out, int((time.monotonic() - started) * 1000)
