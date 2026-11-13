from __future__ import annotations

import json
import sqlite3
import uuid

from sqlalchemy import create_engine

from app.ids import is_uuid, new_id, uuid7_at
from app.migrate_uuid import migrate_int_ids_to_uuid, needs_migration


def test_new_id_is_uuid7_and_time_ordered():
    ids = [new_id() for _ in range(2000)]
    assert all(is_uuid(i) and uuid.UUID(i).version == 7 for i in ids)
    assert ids == sorted(ids) and len(set(ids)) == len(ids)  # 문자열 정렬 = 생성 순서
    assert uuid7_at(1_000, 0) < uuid7_at(1_000, 1) < uuid7_at(1_001, 0)
    assert not is_uuid("1") and not is_uuid('x" or 1==1')


def test_api_ids_are_uuids(client):
    docs = client.get("/api/documents").json()
    assert docs and all(is_uuid(d["id"]) and is_uuid(d["parser_id"]) for d in docs)
    assert client.get("/api/documents/not-a-real-id").status_code == 404


def test_migrate_int_ids_to_uuid(tmp_path):
    """정수 ID로 만든 예전 DB(일부 테이블)를 변환: 참조·JSON 안의 ID·순서 유지, 백업, 재실행 시 무동작."""
    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    con.executescript("""
    CREATE TABLE parsers (id INTEGER PRIMARY KEY, name VARCHAR(200), description TEXT, version VARCHAR(50), owner VARCHAR(200),
      input_formats JSON, adapter VARCHAR(50), param_schema JSON, api_url VARCHAR(1000), api_mode VARCHAR(20), api_timeout_sec INTEGER,
      auth_header VARCHAR(100), auth_env VARCHAR(200), enabled BOOLEAN, created_at DATETIME, updated_at DATETIME);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name VARCHAR(200), description TEXT, parent_id INTEGER, sort_order INTEGER,
      created_at DATETIME, updated_at DATETIME);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, parser_id INTEGER, title VARCHAR(500), project_id INTEGER, content JSON,
      created_at DATETIME, updated_at DATETIME);
    CREATE TABLE chunk_runs (id INTEGER PRIMARY KEY, document_id INTEGER, method VARCHAR(30), snapshot JSON, chunks JSON,
      created_at DATETIME, updated_at DATETIME);
    CREATE TABLE vector_stores (id INTEGER PRIMARY KEY, name VARCHAR(200), kind VARCHAR(30), created_at DATETIME, updated_at DATETIME);
    CREATE TABLE embedding_models (id INTEGER PRIMARY KEY, name VARCHAR(200), provider VARCHAR(50), model_id VARCHAR(300),
      created_at DATETIME, updated_at DATETIME);
    CREATE TABLE vector_indexes (id INTEGER PRIMARY KEY, name VARCHAR(200), store_id INTEGER, collection VARCHAR(255),
      embedding_model_id INTEGER, run_ids JSON, stats JSON, warnings JSON, created_at DATETIME, updated_at DATETIME);
    """)
    t1, t2 = "2026-11-01 01:00:00.000000", "2026-11-02 02:00:00.000000"
    con.execute("INSERT INTO parsers (id, name, adapter, enabled, created_at, updated_at) VALUES (1, 'p', 'standard', 1, ?, ?)", (t1, t1))
    con.execute("INSERT INTO projects (id, name, parent_id, created_at, updated_at) VALUES (1, '상위', NULL, ?, ?)", (t1, t1))
    con.execute("INSERT INTO projects (id, name, parent_id, created_at, updated_at) VALUES (2, '하위', 1, ?, ?)", (t2, t2))
    for i, t in ((1, t1), (2, t2)):
        con.execute("INSERT INTO documents (id, parser_id, title, project_id, content, created_at, updated_at) VALUES (?, 1, ?, 2, '{}', ?, ?)",
                    (i, f"문서{i}", t, t))
    snap = json.dumps({"document": {"id": 2}, "project": {"id": 2, "profile_sources": {"method": 1}}})
    con.execute("INSERT INTO chunk_runs (id, document_id, method, snapshot, chunks, created_at, updated_at) VALUES (7, 2, 'rule_structure', ?, '[]', ?, ?)",
                (snap, t2, t2))
    con.execute("INSERT INTO vector_stores (id, name, kind, created_at, updated_at) VALUES (1, 'm', 'memory', ?, ?)", (t1, t1))
    con.execute("INSERT INTO embedding_models (id, name, provider, model_id, created_at, updated_at) VALUES (1, 'e', 'mock', 'x', ?, ?)", (t1, t1))
    con.execute("INSERT INTO vector_indexes (id, name, store_id, collection, embedding_model_id, run_ids, stats, warnings, created_at, updated_at) "
                "VALUES (1, 'ix', 1, 'cs_old', 1, '[7]', '{\"last_run_id\": 7}', '[]', ?, ?)", (t2, t2))
    # 이미 지워진 저장소(99)를 가리키는 행: 옮기지 않고 건너뛴다
    con.execute("INSERT INTO vector_indexes (id, name, store_id, collection, embedding_model_id, run_ids, stats, warnings, created_at, updated_at) "
                "VALUES (2, 'dangling', 99, 'cs_gone', 1, '[]', '{}', '[]', ?, ?)", (t2, t2))
    con.commit()
    con.close()

    engine = create_engine(f"sqlite:///{db.as_posix()}")
    assert needs_migration(engine)
    backup = migrate_int_ids_to_uuid(engine)
    assert backup and (tmp_path / backup.split("\\")[-1].split("/")[-1]).exists()

    con = sqlite3.connect(db)
    projects = dict(con.execute("SELECT name, id FROM projects"))
    assert all(is_uuid(v) for v in projects.values())
    assert con.execute("SELECT parent_id FROM projects WHERE name='하위'").fetchone()[0] == projects["상위"]
    docs = con.execute("SELECT id, title, project_id, parser_id FROM documents ORDER BY id").fetchall()
    assert [d[1] for d in docs] == ["문서1", "문서2"]  # 생성 순서 유지
    assert all(d[2] == projects["하위"] for d in docs)
    run_id, doc_id, snap = con.execute("SELECT id, document_id, snapshot FROM chunk_runs").fetchone()
    snap = json.loads(snap)
    assert doc_id == docs[1][0] and snap["document"]["id"] == doc_id
    assert snap["project"]["id"] == projects["하위"] and snap["project"]["profile_sources"]["method"] == projects["상위"]
    assert [r[0] for r in con.execute("SELECT name FROM vector_indexes")] == ["ix"]
    run_ids, stats, warnings = con.execute("SELECT run_ids, stats, warnings FROM vector_indexes").fetchone()
    assert json.loads(run_ids) == [run_id] and json.loads(stats)["last_run_id"] == run_id
    assert "다시 적재" in json.loads(warnings)[-1]
    con.close()
    assert not needs_migration(engine)  # 두 번째 시작에서는 아무것도 하지 않음
    assert migrate_int_ids_to_uuid(engine) is None
