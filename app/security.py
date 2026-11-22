import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import User

# Все права в системе. Роль хранит подмножество этого списка, владелец имеет всё.
PERMISSIONS = {
    "products.read": "Видеть каталог и остатки",
    "products.write": "Создавать и менять товары, категории, поставщиков",
    "stock.manage": "Импорт, заказы, инвентаризация, перемещение, переоценка, списание",
    "sales.create": "Продавать на кассе",
    "sales.read": "Видеть все продажи",
    "sales.return": "Оформлять возвраты",
    "clients.read": "Видеть клиентов",
    "clients.write": "Создавать клиентов, принимать оплату долга",
    "marketing.manage": "Акции, промокоды, SMS-рассылки",
    "reports.read": "Главная и отчёты",
    "staff.manage": "Сотрудники и роли",
    "settings.manage": "Настройки компании, магазины, цели",
}

ITERATIONS = 260_000
oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, it, salt, digest = stored.split("$")
    except ValueError:
        return False
    calc = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(it))
    return hmac.compare_digest(calc.hex(), digest)


def create_token(user: User) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_minutes)
    return jwt.encode({"sub": str(user.id), "cid": user.company_id, "exp": exp}, settings.secret_key, algorithm="HS256")


def current_user(token: str = Depends(oauth2), db: Session = Depends(get_db)) -> User:
    err = HTTPException(status.HTTP_401_UNAUTHORIZED, "Войдите снова: сессия истекла или токен неверный",
                        headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise err
    user = db.get(User, int(payload["sub"]))
    if not user or not user.is_active:
        raise err
    return user


def user_permissions(user: User) -> set[str]:
    if user.is_owner:
        return set(PERMISSIONS)
    return set(user.role.permissions) if user.role else set()


def require(*perms: str):
    """Зависимость для роутов: Depends(require("sales.create"))."""
    def checker(user: User = Depends(current_user)) -> User:
        missing = [p for p in perms if p not in user_permissions(user)]
        if missing:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Нет прав: {', '.join(PERMISSIONS[p] for p in missing)}")
        return user
    return checker


def check_store_access(user: User, store_id: int) -> None:
    if user.is_owner or not user.store_ids:
        return
    if store_id not in user.store_ids:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Нет доступа к этому магазину")
