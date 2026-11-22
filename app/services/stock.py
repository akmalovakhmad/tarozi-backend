from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Product, StockLevel, StockMovement


def get_level(db: Session, product_id: int, store_id: int, lock: bool = True) -> StockLevel:
    q = select(StockLevel).where(StockLevel.product_id == product_id, StockLevel.store_id == store_id)
    if lock:
        q = q.with_for_update()  # в PostgreSQL блокирует строку, чтобы две кассы не продали последний товар
    level = db.scalar(q)
    if level is None:
        level = StockLevel(product_id=product_id, store_id=store_id, qty=Decimal("0"))
        db.add(level)
        db.flush()
    return level


def change_stock(db: Session, *, company_id: int, product: Product, store_id: int, delta: Decimal,
                 reason: str, ref_id: int | None, user_id: int | None, allow_negative: bool) -> StockLevel:
    """Единственное место, где меняется остаток. Всегда пишет строку в журнал движений."""
    if product.is_service:
        return None
    level = get_level(db, product.id, store_id)
    new_qty = Decimal(level.qty) + Decimal(delta)
    if new_qty < 0 and not allow_negative:
        raise HTTPException(409, f"Не хватает товара «{product.name}»: на складе {level.qty:g}, нужно {-Decimal(delta):g}")
    level.qty = new_qty
    db.add(StockMovement(company_id=company_id, product_id=product.id, store_id=store_id, delta=delta,
                         reason=reason, ref_id=ref_id, user_id=user_id))
    return level
