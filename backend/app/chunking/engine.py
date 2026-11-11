"""경계 기반 LLM 시멘틱 청킹 엔진 (requirements 5.3~5.4).

흐름
1. 실행 범위·제외 타입 적용 (CI-04, 5.7)
2. 모델 컨텍스트에 맞춘 윈도우 구성 (CI-02, MS-07)
3. 윈도우별 LLM 호출 → JSON 파싱 → 재시도 → repair 프롬프트 → 규칙 기반 fallback (CV-06)
4. 윈도우 내 경계 정규화: 잘못된 ID·역전·겹침·누락 처리 (CV-02~04)
5. Stitching (CI-03): 마지막 윈도우가 아니면 윈도우의 마지막 청크는 확정하지 않고,
   다음 윈도우를 그 청크의 시작 Element부터 다시 시작해 경계를 재판단한다.
6. 원본 Element 텍스트로 청크 본문 조립 (CV-07), 최종 검증 (CV-02~05)
"""
from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..llm import ChatRequest, LLMError, generate
from ..models import LLMModel, PromptVersion
from ..standard import Element, StandardDocument
from ..tokens import estimate_tokens
from . import prompting

ProgressFn = Callable[[dict[str, Any]], None]


@dataclass
class ChunkSettings:
    max_tokens: int = 512
    min_tokens: int = 64
    window_tokens: int | None = None  # None이면 모델 컨텍스트 기준 자동
    exclude_types: list[str] = field(default_factory=lambda: ["header", "footer"])
    scope: dict[str, Any] = field(default_factory=lambda: {"mode": "all"})
    auto_fix: bool = True
    retries: int = 1
    doc_type: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> ChunkSettings:
        data = dict(data or {})
        known = {k: data[k] for k in cls.__dataclass_fields__ if k in data and data[k] is not None}
        return cls(**known)

    def to_dict(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


@dataclass
class Span:
    start: int  # 윈도우/전체 기준 인덱스 (포함)
    end: int  # 포함
    meta: dict[str, Any]
    source: str = "llm"  # llm | fallback | rule
    window: int | None = None


@dataclass
class ChunkingResult:
    chunks: list[dict[str, Any]]
    windows: list[dict[str, Any]]
    validation: dict[str, Any]
    totals: dict[str, Any]
    excluded_ids: list[str]


class OutputParseError(ValueError):
    pass


# ------------------------------------------------------------------ 범위 선택
def select_elements(doc: StandardDocument, cs: ChunkSettings) -> tuple[list[Element], list[Element]]:
    ordered = doc.ordered_elements()
    scope = cs.scope or {"mode": "all"}
    mode = scope.get("mode", "all")
    if mode == "pages":
        p_from = int(scope.get("page_from") or 1)
        p_to = int(scope.get("page_to") or p_from)
        ordered = [e for e in ordered if e.page is not None and p_from <= e.page <= p_to]
    elif mode == "section":
        sid = scope.get("section_id")
        idx = next((i for i, e in enumerate(ordered) if e.element_id == sid), None)
        if idx is None:
            raise ValueError(f"섹션 Element를 찾을 수 없습니다: {sid}")
        head = ordered[idx]
        level = head.level or 1
        end = len(ordered)
        for j in range(idx + 1, len(ordered)):
            e = ordered[j]
            if e.type in {"title", "heading"} and (e.level or 1) <= level:
                end = j
                break
        ordered = ordered[idx:end]
    excluded = [e for e in ordered if e.type in set(cs.exclude_types)]
    included = [e for e in ordered if e.type not in set(cs.exclude_types)]
    return included, excluded


# ------------------------------------------------------------------ 출력 파싱/정규화
_FENCE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$")


def parse_output(text: str) -> list[dict[str, Any]]:
    s = (text or "").strip()
    s = _FENCE.sub("", s).strip()
    if not s.startswith("{"):
        first, last = s.find("{"), s.rfind("}")
        if first == -1 or last <= first:
            raise OutputParseError("JSON 객체를 찾을 수 없습니다")
        s = s[first : last + 1]
    try:
        data = json.loads(s)
    except json.JSONDecodeError as exc:
        raise OutputParseError(f"JSON 파싱 실패: {exc}") from exc
    if isinstance(data, list):
        data = {"chunks": data}
    chunks = data.get("chunks") if isinstance(data, dict) else None
    if not isinstance(chunks, list):
        raise OutputParseError("'chunks' 배열이 없습니다")
    out = []
    for i, c in enumerate(chunks):
        if not isinstance(c, dict):
            raise OutputParseError(f"chunks[{i}]가 객체가 아닙니다")
        start, end = c.get("start_id"), c.get("end_id")
        ids = c.get("element_ids")
        if (not start or not end) and isinstance(ids, list) and ids:
            start, end = ids[0], ids[-1]
        if not isinstance(start, str) or not isinstance(end, str):
            raise OutputParseError(f"chunks[{i}]에 start_id/end_id가 없습니다")
        out.append({**c, "start_id": start.strip(), "end_id": end.strip()})
    return out


def normalize_spans(
    items: list[dict[str, Any]], ids: list[str], auto_fix: bool
) -> tuple[list[Span], list[dict[str, Any]]]:
    """LLM이 반환한 경계를 윈도우 Element 인덱스 구간으로 정규화."""
    index = {eid: i for i, eid in enumerate(ids)}
    issues: list[dict[str, Any]] = []
    spans: list[Span] = []
    for n, item in enumerate(items):
        s, e = index.get(item["start_id"]), index.get(item["end_id"])
        if s is None or e is None:
            bad = [x for x in (item["start_id"], item["end_id"]) if x not in index]
            issues.append({"level": "error", "code": "invalid_id", "message": f"청크 {n + 1}: 존재하지 않는 ID {bad}"})
            continue
        if s > e:
            issues.append({"level": "warning", "code": "range_reversed", "message": f"청크 {n + 1}: start>end 역전 → 교정"})
            s, e = e, s
        meta = {k: item.get(k) for k in ("title", "summary", "keywords", "reason")}
        spans.append(Span(s, e, meta))
    if any(b.start < a.start for a, b in zip(spans, spans[1:], strict=False)):
        issues.append({"level": "warning", "code": "order", "message": "청크가 문서 순서대로 반환되지 않음 → 정렬"})
    spans.sort(key=lambda sp: (sp.start, sp.end))
    fixed: list[Span] = []
    for sp in spans:
        if fixed and sp.start <= fixed[-1].end:
            issues.append({
                "level": "warning", "code": "overlap",
                "message": f"{ids[sp.start]}~{ids[sp.end]}가 앞 청크와 겹침 → 겹친 부분 제거",
            })
            sp.start = fixed[-1].end + 1
            if sp.start > sp.end:
                continue
        fixed.append(sp)
    if auto_fix and fixed:
        if fixed[0].start > 0:
            issues.append({"level": "warning", "code": "gap", "message": f"{ids[0]}~{ids[fixed[0].start - 1]} 누락 → 첫 청크에 포함"})
            fixed[0].start = 0
        for prev, cur in zip(fixed, fixed[1:], strict=False):
            if cur.start > prev.end + 1:
                issues.append({
                    "level": "warning", "code": "gap",
                    "message": f"{ids[prev.end + 1]}~{ids[cur.start - 1]} 누락 → 앞 청크에 포함",
                })
                prev.end = cur.start - 1
        if fixed[-1].end < len(ids) - 1:
            issues.append({"level": "warning", "code": "gap", "message": f"{ids[fixed[-1].end + 1]}~{ids[-1]} 누락 → 마지막 청크에 포함"})
            fixed[-1].end = len(ids) - 1
    return fixed, issues


# ------------------------------------------------------------------ 규칙 기반 청킹 (baseline / fallback)
def rule_spans(elements: list[Element], max_tokens: int, reason_prefix: str = "규칙") -> list[Span]:
    """Structure 청커: heading에서 나누고, 토큰 상한을 넘으면 Element 경계에서 나눈다."""
    spans: list[Span] = []
    start = 0
    tokens = 0
    only_headings = True
    for i, el in enumerate(elements):
        t = estimate_tokens(el.content_text())
        is_heading = el.type in {"title", "heading"}
        if i > start and is_heading and not only_headings:
            spans.append(Span(start, i - 1, {"reason": f"{reason_prefix}: heading 경계"}, source="rule"))
            start, tokens, only_headings = i, 0, True
        elif i > start and tokens + t > max_tokens:
            spans.append(Span(start, i - 1, {"reason": f"{reason_prefix}: 토큰 상한({max_tokens}) 도달"}, source="rule"))
            start, tokens, only_headings = i, 0, True
        tokens += t
        only_headings = only_headings and is_heading
    if elements:
        spans.append(Span(start, len(elements) - 1, {"reason": f"{reason_prefix}: 끝"}, source="rule"))
    for sp in spans:
        first = elements[sp.start]
        sp.meta.setdefault("title", first.text[:60] if first.type in {"title", "heading"} else "")
    return spans


# ------------------------------------------------------------------ 메인
def auto_window_budget(model: LLMModel | None, pv: PromptVersion | None, params: dict[str, Any]) -> int:
    if model is None:
        return 6000
    out_reserve = int(params.get("max_tokens") or model.max_output_tokens)
    overhead = 0
    if pv:
        overhead = estimate_tokens(pv.system_template + pv.user_template)
        overhead += estimate_tokens(prompting.render_few_shots(pv.few_shots or []))
    budget = model.context_length - out_reserve - overhead - 512
    return max(400, min(budget, 12000))


def run_chunking(
    doc: StandardDocument,
    *,
    method: str,
    settings: ChunkSettings,
    model: LLMModel | None = None,
    prompt_version: PromptVersion | None = None,
    params: dict[str, Any] | None = None,
    doc_title: str = "",
    on_progress: ProgressFn | None = None,
) -> ChunkingResult:
    params = dict(params or {})
    elements, excluded = select_elements(doc, settings)
    by_id = {e.element_id: e for e in doc.elements}
    el_tokens = [estimate_tokens(prompting.render_element(e)) for e in elements]
    windows: list[dict[str, Any]] = []
    spans: list[Span] = []

    if method == "rule_structure" or not elements:
        spans = rule_spans(elements, settings.max_tokens)
        for sp in spans:
            sp.source = "rule"
    else:
        if model is None or prompt_version is None:
            raise ValueError("LLM 청킹에는 모델과 프롬프트 버전이 필요합니다")
        budget = settings.window_tokens or auto_window_budget(model, prompt_version, params)
        total_tokens = sum(el_tokens)
        est_windows = max(1, -(-total_tokens // budget))
        i = 0
        while i < len(elements):
            j, tok = i, 0
            while j < len(elements) and (j == i or tok + el_tokens[j] <= budget):
                tok += el_tokens[j]
                j += 1
            win_elements = elements[i:j]
            is_last = j >= len(elements)
            w_idx = len(windows)
            if on_progress:
                on_progress({"phase": "window", "window": w_idx + 1, "estimated_windows": max(est_windows, w_idx + 1),
                             "elements_done": i, "elements_total": len(elements)})
            local, log = _process_window(
                w_idx, win_elements, by_id, model, prompt_version, params, settings, doc_title
            )
            log.update({"start_index": i, "end_index": j - 1, "tokens": tok, "is_last": is_last})
            if not is_last and len(local) >= 2:
                carried = local.pop()
                next_i = i + carried.start
                log["stitch"] = f"마지막 청크({win_elements[carried.start].element_id}~)를 다음 윈도우에서 재판단"
            else:
                next_i = j
                if not is_last:
                    log["stitch"] = "윈도우 전체가 한 청크 → 윈도우 경계에서 강제 분할"
                    log["issues"].append({"level": "warning", "code": "forced_split",
                                          "message": f"{win_elements[-1].element_id} 뒤 윈도우 경계에서 강제 분할"})
            for sp in local:
                spans.append(Span(i + sp.start, i + sp.end, sp.meta, sp.source, w_idx))
            windows.append(log)
            i = next_i

    chunks = _assemble(spans, elements, by_id, settings)
    validation = _validate(chunks, elements, windows, settings)
    totals = _totals(windows, model, chunks)
    if on_progress:
        on_progress({"phase": "done", "elements_done": len(elements), "elements_total": len(elements)})
    return ChunkingResult(chunks, windows, validation, totals, [e.element_id for e in excluded])


def _process_window(
    w_idx: int,
    win: list[Element],
    by_id: dict[str, Element],
    model: LLMModel,
    pv: PromptVersion,
    params: dict[str, Any],
    cs: ChunkSettings,
    doc_title: str,
) -> tuple[list[Span], dict[str, Any]]:
    variables = {
        "elements": prompting.render_elements(win),
        "section_path": prompting.section_path(win[0], by_id),
        "max_tokens": str(cs.max_tokens),
        "min_tokens": str(cs.min_tokens),
        "doc_type": cs.doc_type or "미지정",
        "doc_title": doc_title or "(제목 없음)",
        "few_shots": prompting.render_few_shots(pv.few_shots or []),
    }
    system, unk1 = prompting.render_template(pv.system_template, variables)
    user, unk2 = prompting.render_template(pv.user_template, variables)
    used = set(prompting.template_variables(pv.system_template + pv.user_template))
    if pv.few_shots and "few_shots" not in used:
        system += "\n\n" + variables["few_shots"]
    schema = pv.output_schema or prompting.OUTPUT_SCHEMA
    meta = {
        "elements": [{"id": e.element_id, "type": e.type, "text": e.text,
                      "tokens": estimate_tokens(e.content_text())} for e in win],
        "max_tokens": cs.max_tokens,
    }
    log: dict[str, Any] = {
        "index": w_idx, "first_id": win[0].element_id, "last_id": win[-1].element_id,
        "element_count": len(win), "system": system, "user": user, "attempts": [], "issues": [],
        "warnings": [f"알 수 없는 템플릿 변수: {v}" for v in sorted(set(unk1 + unk2))],
        "fallback": False, "raw_response": "",
    }
    ids = [e.element_id for e in win]
    raw = ""
    parse_error = ""
    items: list[dict[str, Any]] | None = None

    for attempt in range(cs.retries + 1):
        rec: dict[str, Any] = {"kind": "call", "attempt": attempt + 1}
        try:
            res = generate(model, ChatRequest(system, user, schema, params, {**meta, "attempt": attempt}))
        except LLMError as exc:
            rec.update(ok=False, error=str(exc))
            log["attempts"].append(rec)
            if not exc.retryable:
                break
            time.sleep(min(2.0 * (attempt + 1), 5.0))
            continue
        raw = res.text
        rec.update(strategy=res.strategy, latency_ms=res.latency_ms, input_tokens=res.input_tokens,
                   output_tokens=res.output_tokens, request=res.request_preview, raw=res.text)
        log["warnings"].extend(res.warnings)
        try:
            items = parse_output(res.text)
            rec["ok"] = True
            log["attempts"].append(rec)
            log["strategy"] = res.strategy
            break
        except OutputParseError as exc:
            parse_error = str(exc)
            rec.update(ok=False, error=parse_error)
            log["attempts"].append(rec)

    if items is None and raw:
        rec = {"kind": "repair", "attempt": len(log["attempts"]) + 1}
        try:
            res = generate(model, ChatRequest(
                prompting.REPAIR_SYSTEM, prompting.repair_user(raw, parse_error, schema), schema, params,
                {**meta, "repair": True},
            ))
            raw = res.text
            rec.update(strategy=res.strategy, latency_ms=res.latency_ms, input_tokens=res.input_tokens,
                       output_tokens=res.output_tokens, raw=res.text)
            items = parse_output(res.text)
            rec["ok"] = True
            log["strategy"] = res.strategy
        except (LLMError, OutputParseError) as exc:
            rec.update(ok=False, error=str(exc))
        log["attempts"].append(rec)

    log["raw_response"] = raw
    spans: list[Span] = []
    if items is not None:
        spans, issues = normalize_spans(items, ids, cs.auto_fix)
        log["issues"].extend(issues)
        for sp in spans:
            sp.source = "llm"
    if not spans:
        reason = "LLM 호출 실패" if items is None else "유효한 경계가 없음"
        log["fallback"] = True
        log["issues"].append({"level": "warning", "code": "fallback", "message": f"{reason} → 규칙 기반 청킹으로 대체"})
        spans = rule_spans(win, cs.max_tokens, reason_prefix="fallback")
        for sp in spans:
            sp.source = "fallback"
    log["parsed_chunks"] = [{"start_id": ids[s.start], "end_id": ids[s.end], **s.meta} for s in spans]
    return spans, log


def _assemble(
    spans: list[Span], elements: list[Element], by_id: dict[str, Element], cs: ChunkSettings
) -> list[dict[str, Any]]:
    chunks = []
    for n, sp in enumerate(spans, 1):
        els = elements[sp.start : sp.end + 1]
        text = "\n\n".join(e.content_text() for e in els if e.content_text())
        pages = sorted({e.page for e in els if e.page is not None})
        meta = sp.meta or {}
        chunks.append({
            "chunk_id": f"C{n}",
            "start_id": els[0].element_id,
            "end_id": els[-1].element_id,
            "element_ids": [e.element_id for e in els],
            "title": meta.get("title") or "",
            "summary": meta.get("summary") or "",
            "keywords": meta.get("keywords") or [],
            "reason": meta.get("reason") or "",
            "text": text,
            "tokens": estimate_tokens(text),
            "pages": pages,
            "section_path": prompting.section_path(els[0], by_id),
            "source": sp.source,
            "window": sp.window,
        })
    return chunks


def _validate(
    chunks: list[dict[str, Any]], elements: list[Element], windows: list[dict[str, Any]], cs: ChunkSettings
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    order = {e.element_id: i for i, e in enumerate(elements)}
    seen: dict[str, str] = {}
    for c in chunks:
        for eid in c["element_ids"]:
            if eid in seen:
                issues.append({"level": "error", "code": "duplicate", "chunk_id": c["chunk_id"],
                               "message": f"{eid}가 {seen[eid]}와 {c['chunk_id']}에 중복 포함"})
            seen.setdefault(eid, c["chunk_id"])
    missing = [e.element_id for e in elements if e.element_id not in seen]
    if missing:
        preview = ", ".join(missing[:10]) + (" …" if len(missing) > 10 else "")
        issues.append({"level": "error", "code": "missing", "message": f"누락된 Element {len(missing)}개: {preview}",
                       "element_ids": missing})
    starts = [order[c["start_id"]] for c in chunks]
    if starts != sorted(starts):
        issues.append({"level": "error", "code": "order", "message": "청크 순서가 문서 순서와 다릅니다"})
    for c in chunks:
        types = {elements[order[i]].type for i in c["element_ids"]}
        if types <= {"title", "heading"}:
            issues.append({"level": "warning", "code": "heading_only", "chunk_id": c["chunk_id"],
                           "message": f"{c['chunk_id']}: heading만 있는 청크"})
        if c["tokens"] > cs.max_tokens:
            issues.append({"level": "warning", "code": "too_large", "chunk_id": c["chunk_id"],
                           "message": f"{c['chunk_id']}: {c['tokens']} 토큰 > 최대 {cs.max_tokens}"})
        elif c["tokens"] < cs.min_tokens and len(chunks) > 1:
            issues.append({"level": "warning", "code": "too_small", "chunk_id": c["chunk_id"],
                           "message": f"{c['chunk_id']}: {c['tokens']} 토큰 < 최소 {cs.min_tokens}"})
    for w in windows:
        for iss in w.get("issues", []):
            issues.append({**iss, "window": w["index"]})
    counts: dict[str, int] = {}
    for iss in issues:
        counts[iss["code"]] = counts.get(iss["code"], 0) + 1
    return {
        "ok": not any(i["level"] == "error" and "window" not in i for i in issues),
        "error_count": sum(1 for i in issues if i["level"] == "error"),
        "warning_count": sum(1 for i in issues if i["level"] == "warning"),
        "counts": counts,
        "issues": issues,
        "coverage": {"total": len(elements), "covered": len(elements) - len(missing)},
    }


def _totals(windows: list[dict[str, Any]], model: LLMModel | None, chunks: list[dict[str, Any]]) -> dict[str, Any]:
    tin = tout = latency = calls = 0
    for w in windows:
        for a in w.get("attempts", []):
            calls += 1
            latency += a.get("latency_ms") or 0
            tin += a.get("input_tokens") or 0
            tout += a.get("output_tokens") or 0
    cost = 0.0
    if model:
        cost = tin / 1e6 * model.input_price_per_1m + tout / 1e6 * model.output_price_per_1m
    sizes = [c["tokens"] for c in chunks]
    return {
        "windows": len(windows),
        "llm_calls": calls,
        "fallback_windows": sum(1 for w in windows if w.get("fallback")),
        "input_tokens": tin,
        "output_tokens": tout,
        "cost_usd": round(cost, 6),
        "latency_ms": latency,
        "chunk_count": len(chunks),
        "avg_tokens": round(sum(sizes) / len(sizes), 1) if sizes else 0,
        "min_tokens": min(sizes) if sizes else 0,
        "max_tokens": max(sizes) if sizes else 0,
    }
