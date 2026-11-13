"""레코드 ID: UUIDv7 (RFC 9562).

앞 48비트가 밀리초 시각이라 문자열로 정렬해도 생성 순서가 유지된다. 그래서 "가장 최근 실행"처럼
ID 순서에 기대던 조회가 그대로 동작한다. 같은 밀리초 안에서는 12비트 카운터로 순서를 보장한다.
"""
from __future__ import annotations

import os
import re
import threading
import time
import uuid

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_lock = threading.Lock()
_last_ms = 0
_seq = 0


def uuid7_at(ms: int, seq: int) -> str:
    """주어진 밀리초 시각과 순번(0~4095)으로 UUIDv7을 만든다(마이그레이션에서 기존 순서를 재현할 때 사용)."""
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | (seq & 0xFFF) << 64 | 0b10 << 62 | rand_b
    return str(uuid.UUID(int=value))


def new_id() -> str:
    global _last_ms, _seq
    with _lock:
        ms = int(time.time() * 1000)
        if ms <= _last_ms:
            ms = _last_ms
            _seq += 1
            if _seq > 0xFFF:  # 같은 밀리초에 4096개를 넘으면 다음 밀리초로
                ms += 1
                _seq = 0
        else:
            _seq = 0
        _last_ms = ms
        return uuid7_at(ms, _seq)


def is_uuid(value: object) -> bool:
    return isinstance(value, str) and bool(_UUID_RE.match(value))
