"""UI 테스트용 Parser REST API 호출 (PR-02, PR-08, IN-02).

호출 규약
- sync : POST {api_url} multipart(file=<파일>, params=<JSON 문자열>) → 200 + Parser 원본 출력(JSON)
- async: POST {api_url} → {"job_id": "..."} 후 GET {api_status_url}(`{job_id}` 치환)을 폴링
         → {"status": "running"|"done"|"failed", "result": <원본 출력>, "error": "..."}
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .models import Parser


class ParserCallError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind  # parser_error | timeout | config_error


@dataclass
class ParserCallResult:
    payload: Any
    raw_text: str
    elapsed_ms: int


def _headers(parser: Parser) -> dict[str, str]:
    if parser.api_auth_header and parser.api_auth_env:
        value = os.environ.get(parser.api_auth_env, "")
        if not value:
            raise ParserCallError("config_error", f"환경변수 {parser.api_auth_env}가 비어 있습니다")
        return {parser.api_auth_header: value}
    return {}


def call_parser(
    parser: Parser,
    file_name: str,
    data: bytes,
    params: dict[str, Any] | None = None,
    poll_interval: float = 1.0,
    client: httpx.Client | None = None,
) -> ParserCallResult:
    if not parser.api_url:
        raise ParserCallError("config_error", "Parser API URL이 등록되지 않았습니다 (결과 수신 전용 Parser)")
    if len(data) > parser.max_file_mb * 1024 * 1024:
        raise ParserCallError("config_error", f"파일 크기 제한({parser.max_file_mb}MB)을 초과했습니다")
    started = time.monotonic()
    timeout = httpx.Timeout(parser.api_timeout_sec, connect=10.0)
    own = client is None
    client = client or httpx.Client(timeout=timeout)
    try:
        resp = client.post(
            parser.api_url,
            headers=_headers(parser),
            files={parser.api_file_field or "file": (file_name, data)},
            data={"params": json.dumps(params or {}, ensure_ascii=False)},
            timeout=timeout,
        )
        _raise_for_status(resp)
        if parser.api_mode == "async":
            job_id = resp.json().get("job_id")
            if not job_id:
                raise ParserCallError("parser_error", "async 응답에 job_id가 없습니다")
            if not parser.api_status_url:
                raise ParserCallError("config_error", "async 모드에는 상태 조회 URL이 필요합니다")
            status_url = parser.api_status_url.replace("{job_id}", str(job_id))
            deadline = started + parser.api_timeout_sec
            while True:
                if time.monotonic() > deadline:
                    raise ParserCallError("timeout", f"{parser.api_timeout_sec:.0f}초 내에 파싱이 끝나지 않았습니다")
                time.sleep(poll_interval)
                st = client.get(status_url, headers=_headers(parser), timeout=timeout)
                _raise_for_status(st)
                body = st.json()
                status = body.get("status")
                if status == "done":
                    payload = body.get("result")
                    raw = json.dumps(payload, ensure_ascii=False)
                    break
                if status == "failed":
                    raise ParserCallError("parser_error", body.get("error") or "Parser가 실패를 반환했습니다")
        else:
            raw = resp.text
            try:
                payload = resp.json()
            except ValueError as exc:
                raise ParserCallError("parser_error", f"Parser 응답이 JSON이 아닙니다: {exc}") from exc
        return ParserCallResult(payload=payload, raw_text=raw, elapsed_ms=int((time.monotonic() - started) * 1000))
    except httpx.TimeoutException as exc:
        raise ParserCallError("timeout", f"Parser API 타임아웃: {exc}") from exc
    except httpx.HTTPError as exc:
        raise ParserCallError("parser_error", f"Parser API 연결 실패: {exc}") from exc
    finally:
        if own:
            client.close()


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code >= 400:
        raise ParserCallError("parser_error", f"Parser API 오류 HTTP {resp.status_code}: {resp.text[:500]}")
