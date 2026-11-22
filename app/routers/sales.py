"""Продажи: касса, отложенные чеки, список продаж, возвраты."""
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common import get_owned, get_store
from app.db import get_db
from app.models import Client, Company, Sale, SaleReturn, User
from app.schemas import (CompleteHeldIn, ExchangeIn, ExchangeOut, Page, ReturnIn, ReturnOut, SaleIn, SaleOut,
                         SaleQuoteOut)
from app.security import check_store_access, require
from app.services import sales as svc

router = APIRouter(prefix="/api/sales", tags=["Продажи"])


def _client(db, user, client_id):
    return get_owned(db, Client, client_id, user, "Клиент") if client_id else None


def _calc(db, user, data: SaleIn, client):
    return svc.calculate(db, user, data.store_id, client, data.items, data.promo_code, wholesale=data.wholesale,
                         manual_percent=data.manual_discount_percent, manual_amount=data.manual_discount_amount)


@router.get("/sellers")
def sellers(user: User = Depends(require("sales.create")), db: Session = Depends(get_db)):
    """Сотрудники, на которых можно записать продажу."""
    users = db.scalars(select(User).where(User.company_id == user.company_id, User.is_active.is_(True)).order_by(User.name)).all()
    return [{"id": u.id, "name": u.name} for u in users]


@router.post("/quote", response_model=SaleQuoteOut)
def quote(data: SaleIn, user: User = Depends(require("sales.create")), db: Session = Depends(get_db)):
    """Пересчёт чека без сохранения: касса вызывает его при каждом изменении корзины."""
    get_store(db, data.store_id, user)
    client = _client(db, user, data.client_id)
    calc = _calc(db, user, data, client)
    company = db.get(Company, user.company_id)
    return SaleQuoteOut(
        subtotal=calc.subtotal, discount=calc.discount, total=calc.total,
        bonus_available=client.bonus_balance if client else 0,
        bonus_max_for_this_sale=svc.max_bonus(company, client, calc.total),
        items=[{"product_id": l.product.id, "name": l.product.name, "qty": float(l.qty), "price": float(l.price),
                "discount": float(l.discount), "total": float(l.total), "promotion": l.promotion} for l in calc.lines])


@router.post("", response_model=SaleOut, status_code=201)
def create_sale(data: SaleIn, user: User = Depends(require("sales.create")), db: Session = Depends(get_db)):
    """Провести продажу. С hold=true чек откладывается: без оплаты и без списания со склада."""
    get_store(db, data.store_id, user)
    client = _client(db, user, data.client_id)
    calc = _calc(db, user, data, client)
    sale = svc.build_sale(db, user, data.store_id, client, calc, data.comment, "held" if data.hold else "completed",
                          seller_id=data.seller_id)
    if not data.hold:
        svc.finalize(db, user, sale, data.payments, data.bonus_to_use, debt_due_date=data.debt_due_date)
    db.commit()
    db.refresh(sale)
    return sale


@router.get("/held", response_model=list[SaleOut])
def held_sales(store_id: int, user: User = Depends(require("sales.create")), db: Session = Depends(get_db)):
    """Отложенные чеки магазина."""
    get_store(db, store_id, user)
    return db.scalars(select(Sale).where(Sale.company_id == user.company_id, Sale.store_id == store_id,
                                         Sale.status == "held").order_by(Sale.id.desc())).all()


def _sale(db, user, sale_id) -> Sale:
    sale = get_owned(db, Sale, sale_id, user, "Продажа")
    check_store_access(user, sale.store_id)
    return sale


@router.post("/{sale_id}/complete", response_model=SaleOut)
def complete_held(sale_id: int, data: CompleteHeldIn, user: User = Depends(require("sales.create")),
                  db: Session = Depends(get_db)):
    sale = _sale(db, user, sale_id)
    if sale.status != "held":
        raise HTTPException(409, "Этот чек не отложен")
    svc.finalize(db, user, sale, data.payments, data.bonus_to_use, debt_due_date=data.debt_due_date)
    db.commit()
    db.refresh(sale)
    return sale


@router.post("/{sale_id}/exchange", response_model=ExchangeOut, status_code=201)
def exchange(sale_id: int, data: ExchangeIn, user: User = Depends(require("sales.return", "sales.create")),
             db: Session = Depends(get_db)):
    """Обмен: часть старого чека возвращается на склад, её сумма засчитывается в новую продажу.
    Если новая покупка дороже — доплата из payments, если дешевле — разницу возвращаем (refund_method)."""
    old = _sale(db, user, sale_id)
    ret = svc.make_return(db, user, old, ReturnIn.model_construct(items=data.return_items, refund_method="exchange",
                                                                     reason=data.comment or "Обмен"))
    client = db.get(Client, old.client_id) if old.client_id else None
    calc = svc.calculate(db, user, old.store_id, client, data.items, data.promo_code)
    sale = svc.build_sale(db, user, old.store_id, client, calc, data.comment, "completed", seller_id=data.seller_id)
    sale.exchange_of_id = old.id
    credit = min(ret.amount, calc.total)
    refund = ret.amount - credit
    svc.finalize(db, user, sale, data.payments, 0, exchange_credit=credit)
    if refund > 0:
        ret.refund_method = f"exchange+{data.refund_method}"
    db.commit()
    db.refresh(sale)
    return ExchangeOut(sale=SaleOut.model_validate(sale), returned=ret.amount, refund=refund)


@router.post("/{sale_id}/cancel", response_model=SaleOut)
def cancel_held(sale_id: int, user: User = Depends(require("sales.create")), db: Session = Depends(get_db)):
    sale = _sale(db, user, sale_id)
    if sale.status != "held":
        raise HTTPException(409, "Отменить можно только отложенный чек. Для проведённой продажи оформите возврат")
    sale.status = "cancelled"
    db.commit()
    return sale


@router.get("", response_model=Page)
def list_sales(store_id: int | None = None, seller_id: int | None = None, client_id: int | None = None,
               status: str | None = "completed", date_from: date | None = None, date_to: date | None = None,
               number: int | None = None, page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500),
               user: User = Depends(require("sales.read")), db: Session = Depends(get_db)):
    q = select(Sale).where(Sale.company_id == user.company_id)
    if not user.is_owner and user.store_ids:
        q = q.where(Sale.store_id.in_(user.store_ids))
    for col, val in ((Sale.store_id, store_id), (Sale.seller_id, seller_id), (Sale.client_id, client_id),
                     (Sale.status, status), (Sale.number, number)):
        if val is not None:
            q = q.where(col == val)
    offset = timedelta(minutes=db.get(Company, user.company_id).utc_offset_minutes or 0)  # даты — по местному времени
    if date_from:
        q = q.where(Sale.created_at >= datetime.combine(date_from, time.min) - offset)
    if date_to:
        q = q.where(Sale.created_at < datetime.combine(date_to + timedelta(days=1), time.min) - offset)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(q.order_by(Sale.id.desc()).offset((page - 1) * size).limit(size)).all()
    return Page(total=total, items=[SaleOut.model_validate(s).model_dump(mode="json") for s in rows])


@router.get("/{sale_id}", response_model=SaleOut)
def get_sale(sale_id: int, user: User = Depends(require("sales.read")), db: Session = Depends(get_db)):
    return _sale(db, user, sale_id)


@router.post("/{sale_id}/returns", response_model=ReturnOut, status_code=201)
def create_return(sale_id: int, data: ReturnIn, user: User = Depends(require("sales.return")),
                  db: Session = Depends(get_db)):
    sale = _sale(db, user, sale_id)
    ret = svc.make_return(db, user, sale, data)
    db.commit()
    return ret


@router.get("/{sale_id}/returns", response_model=list[ReturnOut])
def list_returns(sale_id: int, user: User = Depends(require("sales.read")), db: Session = Depends(get_db)):
    _sale(db, user, sale_id)
    return db.scalars(select(SaleReturn).where(SaleReturn.sale_id == sale_id).order_by(SaleReturn.id)).all()
