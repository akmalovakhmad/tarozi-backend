from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str):
    kwargs = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {"pool_pre_ping": True}
    eng = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(eng, "connect")
        def _fk_on(dbapi_conn, _):
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
    return eng


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def auto_migrate(eng, metadata) -> list[str]:
    """Добавляет в существующие таблицы колонки, которых там ещё нет (новые поля моделей).
    Ничего не удаляет и не меняет. Для серьёзных изменений структуры — Alembic."""
    from decimal import Decimal

    from sqlalchemy import inspect, text

    insp = inspect(eng)
    tables = set(insp.get_table_names())
    done = []
    with eng.begin() as conn:
        for table in metadata.sorted_tables:
            if table.name not in tables:
                continue
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                ddl = f'ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(eng.dialect)}'
                d = col.default
                if d is not None and getattr(d, "is_scalar", False):
                    v = d.arg
                    if isinstance(v, bool):
                        lit = ("TRUE" if v else "FALSE") if eng.dialect.name == "postgresql" else str(int(v))
                    elif isinstance(v, (int, float, Decimal)):
                        lit = str(v)
                    else:
                        lit = "'" + str(v).replace("'", "''") + "'"
                    ddl += f" DEFAULT {lit}"
                conn.execute(text(ddl))
                done.append(f"{table.name}.{col.name}")
    return done
