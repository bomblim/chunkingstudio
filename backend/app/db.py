from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str):
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args, future=True)


settings.data_dir.mkdir(parents=True, exist_ok=True)
engine = make_engine(settings.db_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def add_missing_columns() -> list[str]:
    """기존 DB에 새로 추가된 컬럼을 보충한다(가벼운 자동 마이그레이션, 컬럼 추가만 지원).

    create_all은 새 테이블만 만들고 기존 테이블에 컬럼을 추가하지 않기 때문에 필요하다.
    """
    from sqlalchemy import inspect, text

    added: list[str] = []
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                coltype = col.type.compile(dialect=engine.dialect)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype}'))
                added.append(f"{table.name}.{col.name}")
    return added


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
