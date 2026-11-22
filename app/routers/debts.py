"""Долги клиентов: список долгов со сроками и статусами, погашения, массовое погашение."""
from datetime import timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.common import money
from app.db import get_db
from app.models import Client, ClientDebt, Company, DebtPayment, Sale, User, now
from app.schemas import DebtOut, DebtPaymentOut, DebtsPayIn, Page
from app.security import require
from app.services.sales import debt_status

router = APIRouter(prefix="/api/debts", tags=["Долги клиентов"])
ZERO = Decimal("0")


def _today(db, user):
    company = db.get(Company, user.company_id)
    return (now() + timedelta(minutes=company.utc_offset_minutes or 0)).date()


@router.get("")
def list_debts(status: Literal["all", "overdue", "unpaid", "partial", "paid"] = "all", q: str | None = None,
               store_id: int | None = None, page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500),
               user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    """Долги со статусами и сводка: сумма долгов, погашено, остаток, сколько должников."""
    today = _today(db, user)
    query = select(ClientDebt, Client).join(Client, Client.id == ClientDebt.client_id).where(ClientDebt.company_id == user.company_id)
    if store_id:
        query = query.where(ClientDebt.store_id == store_id)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Client.name.ilike(like), Client.phone.ilike(like)))
    rows = db.execute(query.order_by(ClientDebt.due_date, ClientDebt.id)).all()
    numbers = dict(db.execute(select(Sale.id, Sale.number).where(Sale.id.in_([d.sale_id for d, _ in rows if d.sale_id]))).all()) if rows else {}
    all_items = [DebtOut(id=d.id, client_id=c.id, client_name=c.name, client_phone=c.phone, sale_id=d.sale_id,
                         sale_number=numbers.get(d.sale_id), store_id=d.store_id, amount=d.amount, paid=d.paid,
                         left=Decimal(d.amount) - Decimal(d.paid), due_date=d.due_date, status=debt_status(d, today),
                         note=d.note, created_at=d.created_at) for d, c in rows]
    counts = {k: sum(1 for x in all_items if x.status == k) for k in ("overdue", "unpaid", "partial", "paid")}
    total = sum((x.amount for x in all_items), ZERO)
    paid = sum((x.paid for x in all_items), ZERO)
    debtors = len({x.client_id for x in all_items if x.status != "paid"})
    items = [x for x in all_items if status == "all" or x.status == status]
    if status == "all":  # сначала открытые, погашенные в конце
        items.sort(key=lambda x: x.status == "paid")
    page_items = items[(page - 1) * size: page * size]
    return {"total": len(items), "items": [x.model_dump(mode="json") for x in page_items],
            "summary": {"total": float(total), "paid": float(paid), "left": float(total - paid), "debtors": debtors,
                        "overdue_sum": float(sum((x.left for x in all_items if x.status == "overdue"), ZERO)), **counts}}


@router.get("/payments", response_model=Page)
def debt_payments(q: str | None = None, page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500),
                  user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    """Все погашения долгов (вкладка «Погашения»)."""
    query = select(DebtPayment, Client.name).join(Client, Client.id == DebtPayment.client_id).where(DebtPayment.company_id == user.company_id)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Client.name.ilike(like), Client.phone.ilike(like)))
    rows = db.execute(query.order_by(DebtPayment.id.desc())).all()
    items = []
    for p, name in rows[(page - 1) * size: page * size]:
        o = DebtPaymentOut.model_validate(p)
        o.client_name = name
        items.append(o.model_dump(mode="json"))
    return Page(total=len(rows), items=items)


@router.post("/pay")
def pay_many(data: DebtsPayIn, user: User = Depends(require("clients.write")), db: Session = Depends(get_db)):
    """Массовое погашение: каждый выбранный долг гасится полностью."""
    debts = db.scalars(select(ClientDebt).where(ClientDebt.id.in_(data.debt_ids), ClientDebt.company_id == user.company_id)).all()
    if len(debts) != len(set(data.debt_ids)):
        raise HTTPException(404, "Часть долгов не найдена")
    total = ZERO
    for d in debts:
        left = money(Decimal(d.amount) - Decimal(d.paid))
        if left <= 0:
            continue
        client = db.get(Client, d.client_id)
        d.paid = Decimal(d.paid) + left
        client.debt_balance = max(ZERO, Decimal(client.debt_balance) - left)
        db.add(DebtPayment(company_id=user.company_id, client_id=client.id, store_id=d.store_id, amount=left,
                           method=data.method, user_id=user.id))
        total += left
    db.commit()
    return {"paid": float(total), "debts": len(debts)}


def sync_legacy_debts(db: Session) -> int:
    """Долги, появившиеся до учёта по срокам (есть только баланс клиента), превращаем в отдельные долги."""
    created = 0
    for c in db.scalars(select(Client).where(Client.debt_balance > 0)).all():
        open_left = sum((Decimal(d.amount) - Decimal(d.paid) for d in db.scalars(select(ClientDebt).where(ClientDebt.client_id == c.id))), ZERO)
        gap = Decimal(c.debt_balance) - open_left
        if gap > 0:
            db.add(ClientDebt(company_id=c.company_id, client_id=c.id, amount=gap, due_date=now().date() + timedelta(days=30),
                              note="Долг до перехода на сроки"))
            created += 1
    db.commit()
    return created
