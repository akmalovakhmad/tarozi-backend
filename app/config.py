import os

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# На Vercel диск только для чтения, кроме /tmp. Без DATABASE_URL база будет временной (сбрасывается).
_DEFAULT_DB = "sqlite:////tmp/tarozi.db" if os.environ.get("VERCEL") else "sqlite:///./tarozi.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = _DEFAULT_DB
    secret_key: str = "dev-only-secret-change-me-in-production-0000"
    access_token_minutes: int = 60 * 12
    cors_origins: list[str] = ["*"]

    @field_validator("database_url")
    @classmethod
    def _driver(cls, v: str) -> str:
        # Neon / Vercel Postgres дают postgres://… — переводим на драйвер psycopg 3
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v


settings = Settings()
