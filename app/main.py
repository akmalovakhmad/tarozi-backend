import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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


@app.get("/", include_in_schema=False)
def root():
    return {"name": "Тарози API", "docs": "/docs"}


@app.get("/api/health", tags=["Служебное"])
def health():
    return {"status": "ok"}
