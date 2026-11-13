from __future__ import annotations

import io

from PIL import Image


def _image_doc(client, tmp_path, name: str, frames: list[Image.Image], **save_kw) -> dict:
    from app.db import SessionLocal
    from app.models import Document

    parser = next(x for x in client.get("/api/parsers").json() if x["adapter"] == "standard")
    doc = client.post("/api/ingest", json={"parser_id": parser["id"], "title": name, "payload": {
        "elements": [{"element_id": "E1", "type": "paragraph", "text": "이미지 문서", "page": 1,
                      "bbox": {"x0": 0.1, "y0": 0.1, "x1": 0.5, "y1": 0.2}}]}}).json()
    path = tmp_path / name
    frames[0].save(path, save_all=len(frames) > 1, append_images=frames[1:], **save_kw)
    with SessionLocal() as db:
        db.get(Document, doc["id"]).source_file_path = str(path)
        db.commit()
    return client.get(f"/api/documents/{doc['id']}").json()


def test_page_image_png_and_multipage_tiff(client, tmp_path):
    doc = _image_doc(client, tmp_path, "scan.png", [Image.new("RGB", (300, 400), "white")])
    assert doc["source_kind"] == "image"
    r = client.get(f"/api/documents/{doc['id']}/page-image/1")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(r.content)).size == (300, 400)
    assert client.get(f"/api/documents/{doc['id']}/page-image/2").status_code == 404

    # 여러 페이지 TIFF(CMYK 포함)는 페이지별 PNG로 변환
    tif = _image_doc(client, tmp_path, "fax.tiff", [Image.new("CMYK", (200, 100)), Image.new("L", (100, 200))])
    p2 = client.get(f"/api/documents/{tif['id']}/page-image/2")
    assert p2.status_code == 200 and Image.open(io.BytesIO(p2.content)).size == (100, 200)
    assert client.get(f"/api/documents/{tif['id']}/page-image/3").status_code == 404


def test_page_image_large_is_downscaled_and_pdf_rejected(client, tmp_path):
    big = _image_doc(client, tmp_path, "big.jpg", [Image.new("RGB", (4800, 1200), "white")])
    w, h = Image.open(io.BytesIO(client.get(f"/api/documents/{big['id']}/page-image/1").content)).size
    assert (w, h) == (2400, 600)  # 비율 유지

    pdf = next(d for d in client.get("/api/documents").json() if d["title"].endswith("(샘플)"))
    detail = client.get(f"/api/documents/{pdf['id']}").json()
    assert detail["source_kind"] in ("pdf", "")
    assert client.get(f"/api/documents/{pdf['id']}/page-image/1").status_code in (400, 404)
