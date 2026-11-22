"""Главная и отчёты. Выручка «чистая» = продажи минус возвраты. Даты — по часовому поясу компании."""
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common import get_store, money
from app.db import get_db
from app.models import Client, Company, Product, PromoCode, Sale, SaleReturn, Store, Target, User, now
from app.security import require

router = APIRouter(prefix="/api/reports", tags=["Отчёты"])
ZERO = Decimal("0")


class Period:
    def __init__(self, company: Company, date_from: date | None, date_to: date | None):
        self.offset = timedelta(minutes=company.utc_offset_minutes or 0)
        today = (now() + self.offset).date()
        self.date_to = date_to or today
        self.date_from = date_from or (self.date_to - timedelta(days=6))
        self.start = datetime.combine(self.date_from, time.min) - self.offset
        self.end = datetime.combine(self.date_to + timedelta(days=1), time.min) - self.offset

    def local_day(self, dt: datetime) -> date:
        return (dt + self.offset).date()

    def days(self) -> list[date]:
        n = (self.date_to - self.date_from).days + 1
        return [self.date_from + timedelta(days=i) for i in range(n)]


def _context(db: Session, user: User, store_id: int | None, date_from, date_to):
    company = db.get(Company, user.company_id)
    if store_id:
        get_store(db, store_id, user)
    period = Period(company, date_from, date_to)
    stores = [store_id] if store_id else (None if user.is_owner or not user.store_ids else user.store_ids)
    return company, period, stores


def _sales(db, user, period: Period, stores) -> list[Sale]:
    q = select(Sale).where(Sale.company_id == user.company_id, Sale.status == "completed",
                           Sale.created_at >= period.start, Sale.created_at < period.end)
    if stores is not None:
        q = q.where(Sale.store_id.in_(stores))
    return list(db.scalars(q))


def _returns(db, user, period: Period, stores) -> list[SaleReturn]:
    q = select(SaleReturn).where(SaleReturn.company_id == user.company_id,
                                 SaleReturn.created_at >= period.start, SaleReturn.created_at < period.end)
    if stores is not None:
        q = q.where(SaleReturn.store_id.in_(stores))
    return list(db.scalars(q))


def _net_items(sale: Sale):
    """Строки чека с учётом уже возвращённого количества."""
    for it in sale.items:
        left = Decimal(it.qty) - Decimal(it.returned_qty)
        share = left / Decimal(it.qty) if it.qty else ZERO
        yield it, left, money(Decimal(it.total) * share), money(Decimal(it.cost_price) * left)


def _f(x) -> float:
    return float(money(x))


def _target_progress(db, user, company, store_id):
    today = (now() + timedelta(minutes=company.utc_offset_minutes or 0)).date()
    q = select(Target).where(Target.company_id == user.company_id, Target.period_start <= today,
                             Target.period_end >= today, Target.store_id == store_id if store_id else Target.store_id.is_(None))
    target = db.scalars(q.order_by(Target.id.desc())).first()
    if not target:
        return None
    period = Period(company, target.period_start, target.period_end)
    stores = [store_id] if store_id else None
    net = sum((Decimal(s.total) for s in _sales(db, user, period, stores)), ZERO) - \
        sum((Decimal(r.amount) for r in _returns(db, user, period, stores)), ZERO)
    days_left = (target.period_end - today).days + 1
    remaining = max(ZERO, Decimal(target.amount) - net)
    return {"amount": _f(target.amount), "done": _f(net),
            "percent": round(float(net / Decimal(target.amount) * 100), 1),
            "period_start": target.period_start, "period_end": target.period_end,
            "per_day_needed": _f(remaining / days_left) if days_left > 0 else 0}


@router.get("/dashboard")
def dashboard(store_id: int | None = None, date_from: date | None = None, date_to: date | None = None,
              user: User = Depends(require("reports.read")), db: Session = Depends(get_db)):
    """Всё для главной: выручка, платежи, транзакции, график по дням, топы, цель."""
    company, period, stores = _context(db, user, store_id, date_from, date_to)
    sales, returns = _sales(db, user, period, stores), _returns(db, user, period, stores)

    payments = defaultdict(lambda: ZERO)
    goods = services = ZERO
    days = {d: {"date": d, "net": ZERO, "cash": ZERO, "card": ZERO, "debt": ZERO, "bonus": ZERO} for d in period.days()}
    for s in sales:
        day = days[period.local_day(s.created_at)]
        day["net"] += Decimal(s.total)
        for p in s.payments:
            payments[p.method] += Decimal(p.amount)
            day[p.method] += Decimal(p.amount)
        for it in s.items:
            if it.is_service:
                services += Decimal(it.qty)
            else:
                goods += Decimal(it.qty)
    for r in returns:
        days[period.local_day(r.created_at)]["net"] -= Decimal(r.amount)

    gross = sum((Decimal(s.total) for s in sales), ZERO)
    ret_sum = sum((Decimal(r.amount) for r in returns), ZERO)

    sellers, products = defaultdict(lambda: ZERO), defaultdict(lambda: {"name": "", "qty": ZERO, "net": ZERO})
    for s in sales:
        for it, left, net, _ in _net_items(s):
            sellers[s.seller_id] += net
            products[it.product_id]["name"] = it.name
            products[it.product_id]["qty"] += left
            products[it.product_id]["net"] += net
    names = {u.id: u.name for u in db.scalars(select(User).where(User.company_id == user.company_id))}

    return {
        "period": {"from": period.date_from, "to": period.date_to},
        "currency": company.currency,
        "revenue": {"gross": _f(gross), "returns": _f(ret_sum), "net": _f(gross - ret_sum)},
        "payments": {m: _f(payments[m]) for m in ("cash", "card", "debt", "bonus")},
        "transactions": {"count": len(sales), "goods_qty": float(goods), "services_qty": float(services),
                         "returns_count": len(returns),
                         "average_check": _f(gross / len(sales)) if sales else 0},
        "by_day": [{k: (_f(v) if isinstance(v, Decimal) else v) for k, v in d.items()} for d in days.values()],
        "top_sellers": sorted(({"seller_id": k, "name": names.get(k, "—"), "net": _f(v)} for k, v in sellers.items()),
                              key=lambda x: -x["net"])[:10],
        "top_products": sorted(({"product_id": k, "name": v["name"], "qty": float(v["qty"]), "net": _f(v["net"])}
                                for k, v in products.items()), key=lambda x: -x["net"])[:10],
        "target": _target_progress(db, user, company, store_id),
    }


@router.get("/stores")
def by_stores(date_from: date | None = None, date_to: date | None = None,
              user: User = Depends(require("reports.read")), db: Session = Depends(get_db)):
    company, period, stores = _context(db, user, None, date_from, date_to)
    rows = defaultdict(lambda: {"checks": 0, "net": ZERO, "cost": ZERO})
    for s in _sales(db, user, period, stores):
        r = rows[s.store_id]
        r["checks"] += 1
        for _, _, net, cost in _net_items(s):
            r["net"] += net
            r["cost"] += cost
    names = {st.id: st.name for st in db.scalars(select(Store).where(Store.company_id == user.company_id))}
    return [{"store_id": k, "name": names.get(k), "checks": v["checks"], "net": _f(v["net"]),
             "profit": _f(v["net"] - v["cost"]), "average_check": _f(v["net"] / v["checks"]) if v["checks"] else 0}
            for k, v in sorted(rows.items(), key=lambda kv: -kv[1]["net"])]


@router.get("/products")
def by_products(store_id: int | None = None, date_from: date | None = None, date_to: date | None = None,
                user: User = Depends(require("reports.read")), db: Session = Depends(get_db)):
    company, period, stores = _context(db, user, store_id, date_from, date_to)
    rows = defaultdict(lambda: {"name": "", "qty": ZERO, "net": ZERO, "cost": ZERO})
    for s in _sales(db, user, period, stores):
        for it, left, net, cost in _net_items(s):
            r = rows[it.product_id]
            r["name"], r["qty"], r["net"], r["cost"] = it.name, r["qty"] + left, r["net"] + net, r["cost"] + cost
    cats = dict(db.execute(select(Product.id, Product.category_id).where(Product.company_id == user.company_id)).all())
    return [{"product_id": k, "name": v["name"], "category_id": cats.get(k), "qty": float(v["qty"]),
             "net": _f(v["net"]), "profit": _f(v["net"] - v["cost"]),
             "margin_percent": round(float((v["net"] - v["cost"]) / v["net"] * 100), 1) if v["net"] else 0}
            for k, v in sorted(rows.items(), key=lambda kv: -kv[1]["net"])]


@router.get("/sellers")
def by_sellers(store_id: int | None = None, date_from: date | None = None, date_to: date | None = None,
               user: User = Depends(require("reports.read")), db: Session = Depends(get_db)):
    company, period, stores = _context(db, user, store_id, date_from, date_to)
    rows = defaultdict(lambda: {"checks": 0, "net": ZERO, "qty": ZERO})
    for s in _sales(db, user, period, stores):
        r = rows[s.seller_id]
        r["checks"] += 1
        for _, left, net, _ in _net_items(s):
            r["net"] += net
            r["qty"] += left
    names = {u.id: u.name for u in db.scalars(select(User).where(User.company_id == user.company_id))}
    return [{"seller_id": k, "name": names.get(k), "checks": v["checks"], "items": float(v["qty"]),
             "net": _f(v["net"]), "average_check": _f(v["net"] / v["checks"]) if v["checks"] else 0}
            for k, v in sorted(rows.items(), key=lambda kv: -kv[1]["net"])]


@router.get("/clients")
def by_clients(store_id: int | None = None, date_from: date | None = None, date_to: date | None = None,
               user: User = Depends(require("reports.read", "clients.read")), db: Session = Depends(get_db)):
    company, period, stores = _context(db, user, store_id, date_from, date_to)
    rows = defaultdict(lambda: {"checks": 0, "net": ZERO, "last": None})
    anonymous = {"checks": 0, "net": ZERO}
    for s in _sales(db, user, period, stores):
        net = sum((n for _, _, n, _ in _net_items(s)), ZERO)
        if not s.client_id:
            anonymous["checks"] += 1
            anonymous["net"] += net
            continue
        r = rows[s.client_id]
        r["checks"] += 1
        r["net"] += net
        r["last"] = max(r["last"] or s.created_at, s.created_at)
    clients = {c.id: c for c in db.scalars(select(Client).where(Client.id.in_(rows.keys())))} if rows else {}
    return {
        "clients": [{"client_id": k, "name": clients[k].name, "phone": clients[k].phone, "checks": v["checks"],
                     "net": _f(v["net"]), "last_purchase": v["last"], "debt": _f(clients[k].debt_balance),
                     "bonus": _f(clients[k].bonus_balance)}
                    for k, v in sorted(rows.items(), key=lambda kv: -kv[1]["net"])],
        "without_client": {"checks": anonymous["checks"], "net": _f(anonymous["net"])},
    }


@router.get("/marketing")
def marketing(store_id: int | None = None, date_from: date | None = None, date_to: date | None = None,
              user: User = Depends(require("reports.read")), db: Session = Depends(get_db)):
    """Сколько дали скидок и как сработали промокоды."""
    company, period, stores = _context(db, user, store_id, date_from, date_to)
    sales = _sales(db, user, period, stores)
    codes = defaultdict(lambda: {"uses": 0, "revenue": ZERO, "discount": ZERO})
    for s in sales:
        if s.promo_code_id:
            c = codes[s.promo_code_id]
            c["uses"] += 1
            c["revenue"] += Decimal(s.total)
            c["discount"] += Decimal(s.discount)
    names = {p.id: p.code for p in db.scalars(select(PromoCode).where(PromoCode.company_id == user.company_id))}
    discounted = [s for s in sales if Decimal(s.discount) > 0]
    return {
        "total_discount": _f(sum((Decimal(s.discount) for s in sales), ZERO)),
        "checks_with_discount": len(discounted),
        "checks_total": len(sales),
        "bonus_paid": _f(sum((Decimal(p.amount) for s in sales for p in s.payments if p.method == "bonus"), ZERO)),
        "bonus_earned": _f(sum((Decimal(s.bonus_earned) for s in sales), ZERO)),
        "promo_codes": [{"promo_code_id": k, "code": names.get(k), "uses": v["uses"], "revenue": _f(v["revenue"]),
                         "discount": _f(v["discount"])} for k, v in codes.items()],
    }
