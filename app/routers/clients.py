"""Клиенты: база, группы и теги, бонусы, долги и их погашение."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.common import apply_patch, get_owned, get_store, money
from app.db import get_db
from app.models import Client, ClientGroup, DebtPayment, Sale, User
from app.schemas import (ClientGroupIn, ClientGroupOut, ClientIn, ClientOut, ClientPatch, DebtPaymentIn,
                         DebtPaymentOut, Page, SaleOut)
from app.security import require

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
    return Page(total=total, items=[ClientOut.model_validate(c).model_dump(mode="json") for c in rows])


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
    return get_owned(db, Client, client_id, user, "Клиент")


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
    p = DebtPayment(company_id=user.company_id, client_id=c.id, store_id=data.store_id, amount=amount,
                    method=data.method, user_id=user.id)
    db.add(p)
    db.commit()
    return p


@router.get("/clients/{client_id}/debt-payments", response_model=list[DebtPaymentOut])
def debt_payments(client_id: int, user: User = Depends(require("clients.read")), db: Session = Depends(get_db)):
    get_owned(db, Client, client_id, user, "Клиент")
    return db.scalars(select(DebtPayment).where(DebtPayment.client_id == client_id).order_by(DebtPayment.id.desc())).all()
