"""정수 ID → UUID 일회성 마이그레이션 (SQLite).

시작 시 기존 DB의 기본 키가 정수이면:
1. DB 파일을 `studio.db.bak-int-YYYYmmdd-HHMMSS`로 옮겨 백업하고,
2. 같은 스키마(UUID)로 새 DB를 만든 뒤,
3. 모든 행을 옮기면서 기본 키·참조 키·JSON 안의 ID를 UUIDv7로 바꾼다.
   새 ID는 원래 행의 생성 시각으로 만들어 ID 순서(=생성 순서)를 유지한다.

Milvus·메모리 저장소에 이미 적재된 청크는 정수 ID를 그대로 갖고 있으므로 다시 적재해야 한다
(해당 인덱스 기록에 경고를 남긴다).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import JSON, DateTime, inspect, text
from sqlalchemy.engine import Engine

from .db import Base
from .ids import uuid7_at

log = logging.getLogger(__name__)

# FK로 선언되지 않았지만 ID를 담는 컬럼
EXTRA_REFS = {
    ("parse_jobs", "project_id"): "projects",
    ("prompt_versions", "forked_from_version_id"): "prompt_versions",
}
LEGACY_INDEX_WARNING = "UUID 전환 이전에 적재된 컬렉션입니다. 검색 결과의 실행·문서 ID가 맞지 않으니 '컬렉션 비우고 다시 적재'로 다시 적재하세요"


def needs_migration(engine: Engine) -> bool:
    if engine.dialect.name != "sqlite":
        return False
    insp = inspect(engine)
    if "parsers" not in insp.get_table_names():
        return False
    col = next((c for c in insp.get_columns("parsers") if c["name"] == "id"), None)
    return col is not None and "INT" in str(col["type"]).upper()


def _to_dt(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _build_maps(data: dict[str, list[dict[str, Any]]]) -> dict[str, dict[int, str]]:
    maps: dict[str, dict[int, str]] = {}
    for table, rows in data.items():
        if not rows or "id" not in rows[0]:
            continue
        last_ms, seq, m = 0, 0, {}
        for r in sorted(rows, key=lambda x: x["id"]):
            created = _to_dt(r.get("created_at"))
            ms = int(created.timestamp() * 1000) if created else last_ms
            if ms <= last_ms:
                ms, seq = last_ms, seq + 1
                if seq > 0xFFF:
                    ms, seq = ms + 1, 0
            else:
                seq = 0
            last_ms = ms
            m[r["id"]] = uuid7_at(ms, seq)
        maps[table] = m
    return maps


def _map(maps: dict[str, dict[int, str]], table: str, value: Any) -> Any:
    if value is None or value == "":
        return None
    try:
        return maps.get(table, {}).get(int(value))
    except (TypeError, ValueError):
        return value  # 이미 UUID 등


def _fix_json(table: str, row: dict[str, Any], maps: dict[str, dict[int, str]]) -> None:
    if table == "vector_indexes":
        row["run_ids"] = [x for x in (_map(maps, "chunk_runs", r) for r in row.get("run_ids") or []) if x]
        stats = dict(row.get("stats") or {})
        if "last_run_id" in stats:
            stats["last_run_id"] = _map(maps, "chunk_runs", stats["last_run_id"])
        batch = stats.get("batch")
        if isinstance(batch, dict):
            for f in batch.get("failed") or []:
                f["run_id"] = _map(maps, "chunk_runs", f.get("run_id"))
                f["document_id"] = _map(maps, "documents", f.get("document_id"))
        row["stats"] = stats
        if row.get("run_ids"):
            row["warnings"] = [*(row.get("warnings") or []), LEGACY_INDEX_WARNING]
    elif table == "chunk_runs":
        snap = dict(row.get("snapshot") or {})
        if isinstance(snap.get("document"), dict):
            snap["document"]["id"] = _map(maps, "documents", snap["document"].get("id"))
        if isinstance(snap.get("model"), dict):
            snap["model"]["id"] = _map(maps, "llm_models", snap["model"].get("id"))
        if isinstance(snap.get("prompt"), dict):
            snap["prompt"]["prompt_id"] = _map(maps, "prompts", snap["prompt"].get("prompt_id"))
            snap["prompt"]["version_id"] = _map(maps, "prompt_versions", snap["prompt"].get("version_id"))
        if isinstance(snap.get("project"), dict):
            proj = snap["project"]
            proj["id"] = _map(maps, "projects", proj.get("id"))
            proj["profile_sources"] = {k: _map(maps, "projects", v) for k, v in (proj.get("profile_sources") or {}).items()}
        row["snapshot"] = snap


def migrate_int_ids_to_uuid(engine: Engine) -> str | None:
    """마이그레이션했으면 백업 파일 경로를, 필요 없으면 None을 돌려준다."""
    if not needs_migration(engine):
        return None
    from . import models  # noqa: F401  테이블 정의를 메타데이터에 등록

    if not Base.metadata.sorted_tables:
        raise RuntimeError("모델 메타데이터가 비어 있어 마이그레이션할 수 없습니다")
    db_path = Path(engine.url.database or "")
    insp = inspect(engine)
    data: dict[str, list[dict[str, Any]]] = {}
    with engine.connect() as conn:
        for t in insp.get_table_names():
            data[t] = [dict(r._mapping) for r in conn.execute(text(f'SELECT * FROM "{t}"'))]

    tables = {t.name: t for t in Base.metadata.sorted_tables}
    # JSON·시각 컬럼은 원본이 문자열이므로 파이썬 값으로 바꾼다
    for name, rows in data.items():
        table = tables.get(name)
        if table is None:
            continue
        for r in rows:
            for col in table.columns:
                if col.name in r and isinstance(r[col.name], str):
                    if isinstance(col.type, JSON):
                        try:
                            r[col.name] = json.loads(r[col.name])
                        except ValueError:
                            pass
                    elif isinstance(col.type, DateTime):
                        r[col.name] = _to_dt(r[col.name])

    maps = _build_maps(data)
    out: dict[str, list[dict[str, Any]]] = {}
    skipped: list[str] = []
    for name, table in tables.items():
        rows = data.get(name, [])
        refs = {c.name: next(iter(c.foreign_keys)).column.table.name for c in table.columns if c.foreign_keys}
        refs.update({col: tgt for (tbl, col), tgt in EXTRA_REFS.items() if tbl == name})
        required = {c.name for c in table.columns if c.foreign_keys and not c.nullable}
        new_rows = []
        for r in rows:
            nr = {c.name: r[c.name] for c in table.columns if c.name in r}
            for c in table.columns:  # 나중에 추가된 컬럼은 기존 행에 NULL로 남아 있어 기본값으로 채운다
                if nr.get(c.name) is None and not c.nullable and c.default is not None and c.name != "id":
                    arg = c.default.arg
                    nr[c.name] = arg(None) if c.default.is_callable else arg
            if "id" in nr:
                nr["id"] = maps[name][r["id"]]
            for col, target in refs.items():
                if col in nr:
                    nr[col] = _map(maps, target, nr[col])
            # SQLite는 FK를 강제하지 않아 이미 지워진 행을 가리키는 행이 있을 수 있다. 필수 참조가 끊긴 행은 옮기지 않는다
            broken = [c for c in required if nr.get(c) is None]
            if broken:
                skipped.append(f"{name}#{r.get('id')}({', '.join(broken)})")
                continue
            _fix_json(name, nr, maps)
            new_rows.append(nr)
        out[name] = new_rows

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = db_path.with_name(f"{db_path.name}.bak-int-{stamp}")
    engine.dispose()
    shutil.move(str(db_path), str(backup))
    for suffix in ("-wal", "-shm", "-journal"):  # 남은 SQLite 보조 파일 정리
        side = Path(str(db_path) + suffix)
        if side.exists():
            os.remove(side)
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as conn:
            for name, table in tables.items():
                if out.get(name):
                    conn.execute(table.insert(), out[name])
    except Exception:
        engine.dispose()
        if db_path.exists():
            os.remove(db_path)
        shutil.copy2(str(backup), str(db_path))  # 실패하면 원래 DB로 되돌린다
        raise
    counts = {k: len(v) for k, v in out.items() if v}
    log.warning("정수 ID → UUID 마이그레이션 완료 (백업: %s): %s", backup, counts)
    if skipped:
        log.warning("참조 대상이 없어 옮기지 않은 행 %d개: %s", len(skipped), ", ".join(skipped[:20]))
    return str(backup)
