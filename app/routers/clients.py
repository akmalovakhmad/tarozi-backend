"""Клиенты: база, группы и теги, бонусы, долги и их погашение."""
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.common import apply_patch, get_owned, get_store, money
from app.db import get_db
from app.models import Client, ClientDebt, ClientGroup, Company, DebtPayment, Sale, User, now
from app.schemas import (ClientGroupIn, ClientGroupOut, ClientIn, ClientOut, ClientPatch, ClientStats, DebtPaymentIn,
                         DebtPaymentOut, Page, SaleOut)
from app.security import require
from app.services.sales import allocate_debt_payment

router = APIRouter(prefix="/api", tags=["Клиенты"])


@router.get("/client-groups", response_model=list[ClientGroupOut])
def list_groups(user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    return db.scalars(select(ClientGroup).where(ClientGroup.company_id == user.company_id).order_by(ClientGroup.name)).all()


@router.post("/client-groups", response_model=ClientGroupOut, status_code=201)
def create_group(data: ClientGroupIn, user: User = Depends(require("marketing.manage")), db: Session = Depends(get_db)):
    g = ClientGroup(company_id=user.company_id, **data.model_dump())
    db.add(g)
    db.commit()
    return g


@router.put("/client-groups/{group_id}", response_model=ClientGroupOut)
def update_group(group_id: int, data: ClientGroupIn, user: User = Depends(require("marketing.manage")),
                 db: Session = Depends(get_db)):
    g = get_owned(db, ClientGroup, group_id, user, "Группа")
    apply_patch(g, data.model_dump())
    db.commit()
    return g


@router.get("/clients", response_model=Page)
def list_clients(q: str | None = Query(None, description="Имя или телефон"), group_id: int | None = None,
                 tag: str | None = None, has_debt: bool = False, page: int = Query(1, ge=1),
                 size: int = Query(50, ge=1, le=500), user: User = Depends(require("clients.read")),
                 db: Session = Depends(get_db)):
    query = select(Client).where(Client.company_id == user.company_id)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Client.name.ilike(like), Client.phone.ilike(like)))
    if group_id:
        query = query.where(Client.group_id == group_id)
    if has_debt:
        query = query.where(Client.debt_balance > 0)
    rows = db.scalars(query.order_by(Client.debt_balance.desc() if has_debt else Client.name)).all()
    if tag:  # теги в JSON — фильтруем в Python, чтобы работало и в SQLite, и в PostgreSQL
        rows = [c for c in rows if tag in (c.tags or [])]
    total = len(rows)
    rows = rows[(page - 1) * size: page * size]
    return Page(total=total, items=[o.model_dump(mode="json") for o in with_purchases(db, rows)])


def with_purchases(db: Session, clients: list[Client]) -> list[ClientOut]:
    """Добавляет сумму покупок (с учётом возвратов), число покупок и дату последней."""
    ids = [c.id for c in clients]
    agg = {}
    if ids:
        for cid, total, ret, cnt, last in db.execute(
                select(Sale.client_id, func.coalesce(func.sum(Sale.total), 0), func.coalesce(func.sum(Sale.returned_total), 0),
                       func.count(Sale.id), func.max(Sale.created_at))
                .where(Sale.client_id.in_(ids), Sale.status == "completed").group_by(Sale.client_id)).all():
            agg[cid] = (Decimal(total) - Decimal(ret), cnt, last)
    out = []
    for c in clients:
        o = ClientOut.model_validate(c)
        if c.id in agg:
            o.purchases_total, o.purchases_count, o.last_purchase = agg[c.id]
        out.append(o)
    return out


@router.get("/clients/stats", response_model=ClientStats)
def clients_stats(user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    company = db.get(Company, user.company_id)
    today = (now() + timedelta(minutes=company.utc_offset_minutes or 0)).date()
    clients = db.scalars(select(Client).where(Client.company_id == user.company_id)).all()
    last = dict(db.execute(select(Sale.client_id, func.max(Sale.created_at)).where(
        Sale.company_id == user.company_id, Sale.status == "completed", Sale.client_id.isnot(None)).group_by(Sale.client_id)).all())
    week_ago, cutoff = now() - timedelta(days=7), now() - timedelta(days=60)

    def bday_soon(b: date | None) -> bool:
        if not b:
            return False
        for d in range(8):
            x = today + timedelta(days=d)
            if (b.month, b.day) == (x.month, x.day):
                return True
        return False
    return ClientStats(total=len(clients), new_week=sum(1 for c in clients if c.created_at >= week_ago),
                       not_returning=sum(1 for c in clients if c.id in last and last[c.id] < cutoff),
                       birthdays=sum(1 for c in clients if bday_soon(c.birth_date)))


@router.get("/clients/debts/summary")
def debts_summary(user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    total, count = db.execute(select(func.coalesce(func.sum(Client.debt_balance), 0), func.count(Client.id))
                              .where(Client.company_id == user.company_id, Client.debt_balance > 0)).one()
    return {"total_debt": float(total), "debtors": count}


def _check_group(db, user, group_id):
    if group_id:
        get_owned(db, ClientGroup, group_id, user, "Группа")


@router.post("/clients", response_model=ClientOut, status_code=201)
def create_client(data: ClientIn, user: User = Depends(require("clients.write")), db: Session = Depends(get_db)):
    _check_group(db, user, data.group_id)
    if data.phone and db.scalar(select(Client.id).where(Client.company_id == user.company_id, Client.phone == data.phone)):
        raise HTTPException(409, "Клиент с таким телефоном уже есть")
    c = Client(company_id=user.company_id, **data.model_dump())
    db.add(c)
    db.commit()
    return c


@router.get("/clients/{client_id}", response_model=ClientOut)
def get_client(client_id: int, user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    return with_purchases(db, [get_owned(db, Client, client_id, user, "Клиент")])[0]


@router.patch("/clients/{client_id}", response_model=ClientOut)
def update_client(client_id: int, data: ClientPatch, user: User = Depends(require("clients.write")),
                  db: Session = Depends(get_db)):
    c = get_owned(db, Client, client_id, user, "Клиент")
    patch = data.model_dump(exclude_unset=True)
    _check_group(db, user, patch.get("group_id"))
    apply_patch(c, patch)
    db.commit()
    return c


@router.get("/clients/{client_id}/sales", response_model=list[SaleOut])
def client_sales(client_id: int, user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    get_owned(db, Client, client_id, user, "Клиент")
    return db.scalars(select(Sale).where(Sale.client_id == client_id, Sale.status == "completed")
                      .order_by(Sale.id.desc()).limit(200)).all()


@router.post("/clients/{client_id}/debt-payments", response_model=DebtPaymentOut, status_code=201)
def pay_debt(client_id: int, data: DebtPaymentIn, user: User = Depends(require("clients.write")),
             db: Session = Depends(get_db)):
    """Клиент гасит долг (полностью или частично)."""
    c = get_owned(db, Client, client_id, user, "Клиент")
    if data.store_id:
        get_store(db, data.store_id, user)
    amount = money(data.amount)
    if amount > c.debt_balance:
        raise HTTPException(422, f"Долг клиента {c.debt_balance}, нельзя принять больше")
    c.debt_balance = c.debt_balance - amount
    allocate_debt_payment(db, c, amount, debt_ids=data.debt_ids)
    p = DebtPayment(company_id=user.company_id, client_id=c.id, store_id=data.store_id, amount=amount,
                    method=data.method, user_id=user.id)
    db.add(p)
    db.commit()
    return p


@router.get("/clients/{client_id}/debt-payments", response_model=list[DebtPaymentOut])
def debt_payments(client_id: int, user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    get_owned(db, Client, client_id, user, "Клиент")
    return db.scalars(select(DebtPayment).where(DebtPayment.client_id == client_id).order_by(DebtPayment.id.desc())).all()


@router.get("/clients/{client_id}/statement")
def statement(client_id: int, date_from: date | None = None, date_to: date | None = None,
              user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    """Акт сверки: долг на начало, все долги и оплаты за период, долг на конец."""
    c = get_owned(db, Client, client_id, user, "Клиент")
    company = db.get(Company, user.company_id)
    off = timedelta(minutes=company.utc_offset_minutes or 0)
    start = datetime.combine(date_from, time.min) - off if date_from else datetime(2000, 1, 1)
    end = datetime.combine(date_to + timedelta(days=1), time.min) - off if date_to else now() + timedelta(days=1)
    debts = db.scalars(select(ClientDebt).where(ClientDebt.client_id == c.id)).all()
    pays = db.scalars(select(DebtPayment).where(DebtPayment.client_id == c.id)).all()
    numbers = dict(db.execute(select(Sale.id, Sale.number).where(Sale.id.in_([d.sale_id for d in debts if d.sale_id]))).all()) if debts else {}
    opening = sum((Decimal(d.amount) for d in debts if d.created_at < start), Decimal(0)) - \
        sum((Decimal(p.amount) for p in pays if p.created_at < start), Decimal(0))
    rows = [{"date": d.created_at, "kind": "debt", "title": f"Продажа №{numbers[d.sale_id]} в долг" if d.sale_id in numbers else (d.note or "Долг"),
             "debit": float(d.amount), "credit": 0} for d in debts if start <= d.created_at < end]
    names = {"cash": "наличными", "card": "картой", "return": "возвратом товара"}
    rows += [{"date": p.created_at, "kind": "payment", "title": f"Оплата {names.get(p.method, p.method)}", "debit": 0, "credit": float(p.amount)}
             for p in pays if start <= p.created_at < end]
    rows.sort(key=lambda r: r["date"])
    debit, credit = sum(r["debit"] for r in rows), sum(r["credit"] for r in rows)
    return {"client": {"id": c.id, "name": c.name, "phone": c.phone}, "opening": float(opening), "rows": rows,
            "debit": debit, "credit": credit, "closing": float(opening) + debit - credit}
