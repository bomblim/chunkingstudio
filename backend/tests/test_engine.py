from __future__ import annotations

from pathlib import Path

from app import sample_parser
from app.chunking import prompting
from app.chunking.engine import ChunkSettings, normalize_spans, parse_output, run_chunking
from app.models import LLMModel, PromptVersion

SAMPLE = Path(__file__).parents[1] / "app" / "seed" / "sample_policy.md"


def _doc():
    return sample_parser.parse_bytes("sample.md", SAMPLE.read_bytes())


def _mock(**extra) -> LLMModel:
    return LLMModel(name="mock", provider="mock", engine="mock", model_id="mock", context_length=8192,
                    max_output_tokens=2048, structured_output="auto", extra_params=extra, enabled=True,
                    is_external=False, input_price_per_1m=0.0, output_price_per_1m=0.0)


def _pv() -> PromptVersion:
    return PromptVersion(system_template=prompting.DEFAULT_SYSTEM, user_template=prompting.DEFAULT_USER,
                         few_shots=[], output_schema=prompting.OUTPUT_SCHEMA)


def test_sample_parser_markdown():
    doc = _doc()
    types = [e.type for e in doc.elements]
    assert types[0] == "title"
    assert "table" in types and "list" in types
    table = next(e for e in doc.elements if e.type == "table")
    assert table.table and table.table.cells
    sub = next(e for e in doc.elements if e.text.startswith("1.1"))
    parent = next(e for e in doc.elements if e.element_id == sub.parent_id)
    assert parent.text.startswith("1. 원격근무 신청")


def test_parse_output_tolerates_fences_and_element_ids():
    items = parse_output('```json\n{"chunks": [{"element_ids": ["E1", "E2"]}]}\n```')
    assert items[0]["start_id"] == "E1" and items[0]["end_id"] == "E2"


def test_normalize_spans_fixes_invalid_overlap_and_gap():
    ids = ["E1", "E2", "E3", "E4", "E5", "E6"]
    items = [
        {"start_id": "E1", "end_id": "E2"},
        {"start_id": "E2", "end_id": "E3"},  # 겹침
        {"start_id": "E9", "end_id": "E9"},  # 잘못된 ID
        {"start_id": "E6", "end_id": "E5"},  # 역전 + E4 누락
    ]
    spans, issues = normalize_spans(items, ids, auto_fix=True)
    codes = {i["code"] for i in issues}
    assert {"overlap", "invalid_id", "range_reversed", "gap"} <= codes
    covered = [i for sp in spans for i in range(sp.start, sp.end + 1)]
    assert covered == list(range(6))


def test_llm_chunking_with_stitching_covers_everything():
    doc = _doc()
    res = run_chunking(doc, method="llm", settings=ChunkSettings(max_tokens=120, min_tokens=10, window_tokens=250),
                       model=_mock(), prompt_version=_pv())
    assert res.totals["windows"] > 1, "작은 윈도우로 여러 윈도우가 생성되어야 함"
    assert any("stitch" in w for w in res.windows)
    assert res.validation["ok"], res.validation["issues"]
    all_ids = [eid for c in res.chunks for eid in c["element_ids"]]
    expected = [e.element_id for e in doc.ordered_elements() if e.type not in {"header", "footer"}]
    assert all_ids == expected  # 누락·중복·순서 모두 정상
    # 본문은 원본 Element 텍스트로 조립
    by_id = {e.element_id: e for e in doc.elements}
    c0 = res.chunks[0]
    assert by_id[c0["element_ids"][0]].text in c0["text"]


def test_repair_path_after_broken_json():
    doc = _doc()
    res = run_chunking(doc, method="llm", settings=ChunkSettings(retries=0), model=_mock(fail_first_attempt=True),
                       prompt_version=_pv())
    w = res.windows[0]
    assert [a["kind"] for a in w["attempts"]] == ["call", "repair"]
    assert not w["fallback"] and res.validation["ok"]


def test_section_scope_and_rule_baseline():
    doc = _doc()
    sec = next(e for e in doc.elements if e.text.startswith("2. 보안"))
    res = run_chunking(doc, method="rule_structure",
                       settings=ChunkSettings(scope={"mode": "section", "section_id": sec.element_id}))
    ids = [eid for c in res.chunks for eid in c["element_ids"]]
    assert ids[0] == sec.element_id
    assert all(not by.text.startswith("3.") for by in doc.elements if by.element_id in ids)
