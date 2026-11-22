from decimal import ROUND_HALF_UP, Decimal
from typing import TypeVar

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import Store, User

T = TypeVar("T")
CENT = Decimal("0.01")


def money(x) -> Decimal:
    return Decimal(str(x)).quantize(CENT, rounding=ROUND_HALF_UP)


def get_owned(db: Session, model: type[T], obj_id: int | None, user: User, what: str = "Запись") -> T:
    """Достаёт запись по id, только если она принадлежит компании пользователя."""
    obj = db.get(model, obj_id) if obj_id is not None else None
    if obj is None or getattr(obj, "company_id", None) != user.company_id:
        raise HTTPException(404, f"{what} не найден(а)")
    return obj


def get_store(db: Session, store_id: int, user: User) -> Store:
    from app.security import check_store_access
    store = get_owned(db, Store, store_id, user, "Магазин")
    check_store_access(user, store.id)
    return store


def apply_patch(obj, data: dict) -> None:
    for k, v in data.items():
        setattr(obj, k, v)
