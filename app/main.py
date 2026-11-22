import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app import models  # noqa: F401  — регистрирует таблицы
from app.config import settings
from app.db import Base, engine
from app.routers import auth, clients, marketing, products, reports, sales, settings as settings_router, staff, stock


if settings.secret_key.startswith("dev-only"):
    logging.getLogger("uvicorn.error").warning("SECRET_KEY не задан: задайте его в .env перед запуском в работу")
# Таблицы создаются при старте (и на каждом холодном старте на Vercel — это безопасно).
# Для изменений структуры базы в продакшене подключите миграции Alembic (см. README).
Base.metadata.create_all(engine)


app = FastAPI(title="Тарози API", version="0.1.0",
              description="Бэкенд системы учёта для магазина: товары и склад, касса, клиенты, маркетинг, отчёты.")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])

for r in (auth, settings_router, staff, products, stock, sales, clients, marketing, reports):
    app.include_router(r.router)


WEB = Path(__file__).resolve().parent.parent / "public"


@app.get("/", include_in_schema=False)
def root():
    """Сайт (одностраничное приложение). API — по адресам /api/..., документация — /docs."""
    return FileResponse(WEB / "index.html")


@app.get("/api/health", tags=["Служебное"])
def health():
    """Проверка работы: какая база подключена и отвечает ли она."""
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return {"status": "ok" if db_ok else "db_error", "database": engine.dialect.name, "database_ok": db_ok}


# Статика сайта (app.js, app.css). На Vercel папку public/ раздаёт CDN, локально — этот mount.
if WEB.is_dir():
    app.mount("/", StaticFiles(directory=WEB), name="web")
