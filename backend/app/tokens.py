"""토큰 수 추정.

모델별 정확한 토크나이저(MS-08)는 공급자마다 다르고 폐쇄망에서 다운로드가 어려울 수 있어,
MVP는 한국어·영어 혼용 문서에 맞춘 근사치를 쓴다. API가 usage를 돌려주면 그 값을 우선한다.
- 한글/CJK 문자: 문자당 약 1 토큰
- 그 외 문자: 4자당 약 1 토큰
"""
from __future__ import annotations

import math


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0xAC00 <= code <= 0xD7A3  # 한글 음절
        or 0x1100 <= code <= 0x11FF
        or 0x3130 <= code <= 0x318F
        or 0x4E00 <= code <= 0x9FFF  # CJK 통합 한자
        or 0x3040 <= code <= 0x30FF  # 가나
    )


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = sum(1 for ch in text if _is_cjk(ch))
    other = len(text) - cjk
    return cjk + math.ceil(other / 4)
