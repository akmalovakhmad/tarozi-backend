"""Логика кассы: расчёт скидок, проведение продажи, отложенные чеки, возвраты."""
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.common import get_owned, money
from app.models import (Client, ClientGroup, Company, Payment, Product, PromoCode, Promotion, Sale, SaleItem,
                        SaleReturn, now)
from app.schemas import PaymentIn, ReturnIn, SaleItemIn
from app.security import user_permissions
from app.services.stock import change_stock

ZERO = Decimal("0")


@dataclass
class Line:
    product: Product
    qty: Decimal
    price: Decimal
    discount: Decimal = ZERO
    percent: Decimal = ZERO
    promotion: str | None = None

    @property
    def gross(self) -> Decimal:
        return money(self.price * self.qty)

    @property
    def total(self) -> Decimal:
        return self.gross - self.discount


@dataclass
class Calc:
    lines: list[Line]
    subtotal: Decimal
    discount: Decimal
    total: Decimal
    promo: PromoCode | None = None
    notes: list[str] = field(default_factory=list)


def active_promotions(db: Session, company_id: int, store_id: int) -> list[Promotion]:
    t = now()
    q = select(Promotion).where(
        Promotion.company_id == company_id, Promotion.is_active.is_(True),
        or_(Promotion.starts_at.is_(None), Promotion.starts_at <= t),
        or_(Promotion.ends_at.is_(None), Promotion.ends_at >= t))
    return [p for p in db.scalars(q) if not p.store_ids or store_id in p.store_ids]


def find_promo_code(db: Session, company_id: int, code: str) -> PromoCode:
    promo = db.scalar(select(PromoCode).where(PromoCode.company_id == company_id,
                                              func.upper(PromoCode.code) == code.strip().upper()))
    if not promo or not promo.is_active:
        raise HTTPException(422, "Промокод не найден или выключен")
    if promo.expires_at and promo.expires_at < now():
        raise HTTPException(422, "Срок действия промокода закончился")
    if promo.max_uses is not None and promo.used_count >= promo.max_uses:
        raise HTTPException(422, "Промокод уже использован максимальное число раз")
    return promo


def calculate(db: Session, user, store_id: int, client: Client | None, items: list[SaleItemIn],
              promo_code: str | None) -> Calc:
    can_override = "products.write" in user_permissions(user)
    group_pct = ZERO
    if client and client.group_id:
        group = db.get(ClientGroup, client.group_id)
        group_pct = Decimal(group.discount_percent) if group else ZERO
    promos = active_promotions(db, user.company_id, store_id)

    lines: list[Line] = []
    for it in items:
        product = get_owned(db, Product, it.product_id, user, "Товар")
        if not product.is_active:
            raise HTTPException(422, f"Товар «{product.name}» выключен и не продаётся")
        if it.price is not None and it.price != product.retail_price and not can_override:
            raise HTTPException(403, "Менять цену на кассе может только сотрудник с правом редактировать товары")
        line = Line(product=product, qty=Decimal(it.qty), price=Decimal(it.price if it.price is not None else product.retail_price))
        best, best_name = group_pct, ("скидка группы клиента" if group_pct else None)
        for p in promos:
            applies = (not p.product_ids and not p.category_ids) or product.id in p.product_ids \
                or (product.category_id is not None and product.category_id in p.category_ids)
            if applies and Decimal(p.discount_percent) > best:
                best, best_name = Decimal(p.discount_percent), p.name
        line.percent, line.promotion = best, best_name
        line.discount = money(line.gross * best / 100)
        lines.append(line)

    subtotal = sum((l.gross for l in lines), ZERO)
    after_lines = sum((l.total for l in lines), ZERO)
    promo = None
    if promo_code:
        promo = find_promo_code(db, user.company_id, promo_code)
        if after_lines < promo.min_total:
            raise HTTPException(422, f"Промокод действует от суммы {promo.min_total}")
        code_disc = money(after_lines * Decimal(promo.discount_percent) / 100) if promo.discount_percent \
            else min(money(promo.discount_amount), after_lines)
        # раскладываем скидку промокода по строкам, чтобы при возврате вернуть точную сумму
        left = code_disc
        for i, l in enumerate(lines):
            share = left if i == len(lines) - 1 else money(code_disc * l.total / after_lines) if after_lines else ZERO
            share = min(share, l.total)
            l.discount += share
            left -= share
    discount = sum((l.discount for l in lines), ZERO)
    return Calc(lines=lines, subtotal=subtotal, discount=discount, total=subtotal - discount, promo=promo)


def max_bonus(company: Company, client: Client | None, total: Decimal) -> Decimal:
    if not client:
        return ZERO
    return min(Decimal(client.bonus_balance), money(total * Decimal(company.max_bonus_payment_percent) / 100))


def next_number(db: Session, company_id: int) -> int:
    company = db.scalar(select(Company).where(Company.id == company_id).with_for_update())
    company.receipt_counter += 1
    return company.receipt_counter


def build_sale(db: Session, user, store_id: int, client: Client | None, calc: Calc, comment: str | None,
               status: str) -> Sale:
    sale = Sale(company_id=user.company_id, number=next_number(db, user.company_id), store_id=store_id,
                seller_id=user.id, client_id=client.id if client else None, status=status,
                subtotal=calc.subtotal, discount=calc.discount, total=calc.total,
                promo_code_id=calc.promo.id if calc.promo else None, comment=comment)
    for l in calc.lines:
        sale.items.append(SaleItem(product_id=l.product.id, name=l.product.name, is_service=l.product.is_service,
                                   qty=l.qty, price=l.price, cost_price=l.product.cost_price,
                                   discount=l.discount, total=l.total))
    db.add(sale)
    db.flush()
    return sale


def finalize(db: Session, user, sale: Sale, payments: list[PaymentIn], bonus_to_use: Decimal) -> Sale:
    """Принимает оплату, списывает товар со склада, начисляет и списывает бонусы, пишет долг."""
    company = db.get(Company, user.company_id)
    client = db.get(Client, sale.client_id) if sale.client_id else None
    total = Decimal(sale.total)

    bonus = money(bonus_to_use)
    if bonus > 0:
        if not client:
            raise HTTPException(422, "Чтобы оплатить бонусами, выберите клиента")
        if bonus > max_bonus(company, client, total):
            raise HTTPException(422, f"Бонусами можно оплатить не больше {max_bonus(company, client, total)}")

    by_method: dict[str, Decimal] = {}
    for p in payments:
        by_method[p.method] = by_method.get(p.method, ZERO) + money(p.amount)
    paid = sum(by_method.values(), ZERO) + bonus
    if paid != total:
        raise HTTPException(422, f"Сумма оплат {paid} не равна сумме чека {total}")
    if by_method.get("debt") and not client:
        raise HTTPException(422, "Для продажи в долг выберите клиента")

    if sale.promo_code_id:
        promo = db.get(PromoCode, sale.promo_code_id)
        if promo.max_uses is not None and promo.used_count >= promo.max_uses:
            raise HTTPException(422, "Промокод уже использован максимальное число раз")
        promo.used_count += 1

    for item in sale.items:
        product = db.get(Product, item.product_id)
        change_stock(db, company_id=user.company_id, product=product, store_id=sale.store_id, delta=-Decimal(item.qty),
                     reason="sale", ref_id=sale.id, user_id=user.id, allow_negative=company.allow_negative_stock)

    for method, amount in by_method.items():
        sale.payments.append(Payment(method=method, amount=amount))
    if bonus > 0:
        sale.payments.append(Payment(method="bonus", amount=bonus))
        client.bonus_balance = Decimal(client.bonus_balance) - bonus
    if client:
        client.debt_balance = Decimal(client.debt_balance) + by_method.get("debt", ZERO)
        real_money = by_method.get("cash", ZERO) + by_method.get("card", ZERO)
        sale.bonus_earned = money(real_money * Decimal(company.loyalty_percent) / 100)
        client.bonus_balance = Decimal(client.bonus_balance) + sale.bonus_earned
    sale.status = "completed"
    sale.created_at = now()
    return sale


def make_return(db: Session, user, sale: Sale, data: ReturnIn) -> SaleReturn:
    if sale.status != "completed":
        raise HTTPException(422, "Вернуть можно только проведённую продажу")
    company = db.get(Company, user.company_id)
    client = db.get(Client, sale.client_id) if sale.client_id else None
    items = {i.id: i for i in sale.items}
    amount, rows = ZERO, []
    for r in data.items:
        item = items.get(r.sale_item_id)
        if not item:
            raise HTTPException(422, f"Строки {r.sale_item_id} нет в этой продаже")
        left = Decimal(item.qty) - Decimal(item.returned_qty)
        if Decimal(r.qty) > left:
            raise HTTPException(422, f"«{item.name}»: можно вернуть не больше {left:g}")
        part = money(Decimal(item.total) * Decimal(r.qty) / Decimal(item.qty))
        item.returned_qty = Decimal(item.returned_qty) + Decimal(r.qty)
        product = db.get(Product, item.product_id)
        change_stock(db, company_id=user.company_id, product=product, store_id=sale.store_id, delta=Decimal(r.qty),
                     reason="return", ref_id=sale.id, user_id=user.id, allow_negative=True)
        amount += part
        rows.append({"sale_item_id": item.id, "qty": float(r.qty), "amount": float(part)})

    if data.refund_method == "debt":
        if not client or Decimal(client.debt_balance) < amount:
            raise HTTPException(422, "Списать с долга нельзя: у клиента нет такого долга")
        client.debt_balance = Decimal(client.debt_balance) - amount
    if client and sale.bonus_earned and sale.total:
        back = money(Decimal(sale.bonus_earned) * amount / Decimal(sale.total))
        client.bonus_balance = max(ZERO, Decimal(client.bonus_balance) - back)
    sale.returned_total = Decimal(sale.returned_total) + amount
    ret = SaleReturn(company_id=user.company_id, sale_id=sale.id, store_id=sale.store_id, user_id=user.id,
                     amount=amount, refund_method=data.refund_method, items=rows, reason=data.reason)
    db.add(ret)
    return ret
