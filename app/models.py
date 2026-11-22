"""Модели базы данных. Каждая запись принадлежит компании (company_id) — так в одной базе живут разные магазины-клиенты."""
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

Money = Numeric(14, 2)
Qty = Numeric(14, 3)


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Company(Base):
    __tablename__ = "companies"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    loyalty_percent: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))  # % бонусов с оплаты
    max_bonus_payment_percent: Mapped[Decimal] = mapped_column(Money, default=Decimal("50"))  # сколько % чека можно оплатить бонусами
    low_stock_threshold: Mapped[Decimal] = mapped_column(Qty, default=Decimal("5"))
    allow_negative_stock: Mapped[bool] = mapped_column(Boolean, default=False)
    receipt_counter: Mapped[int] = mapped_column(Integer, default=0)
    utc_offset_minutes: Mapped[int] = mapped_column(Integer, default=300)  # часовой пояс для отчётов (Ташкент = +5)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Store(Base):
    __tablename__ = "stores"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    address: Mapped[str | None] = mapped_column(String(300))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Role(Base):
    __tablename__ = "roles"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    permissions: Mapped[list] = mapped_column(JSON, default=list)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    role_id: Mapped[int | None] = mapped_column(ForeignKey("roles.id"))
    name: Mapped[str] = mapped_column(String(200))
    login: Mapped[str] = mapped_column(String(100), unique=True)
    password_hash: Mapped[str] = mapped_column(String(300))
    is_owner: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    store_ids: Mapped[list] = mapped_column(JSON, default=list)  # пусто = доступ ко всем магазинам
    role: Mapped[Role | None] = relationship()


class Category(Base):
    __tablename__ = "categories"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))


class Supplier(Base):
    __tablename__ = "suppliers"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(50))
    note: Mapped[str | None] = mapped_column(Text)


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("company_id", "sku"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(300), index=True)
    sku: Mapped[str | None] = mapped_column(String(100))
    barcode: Mapped[str | None] = mapped_column(String(100), index=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    unit: Mapped[str] = mapped_column(String(20), default="шт")
    is_service: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    cost_price: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    retail_price: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class StockLevel(Base):
    __tablename__ = "stock_levels"
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    qty: Mapped[Decimal] = mapped_column(Qty, default=Decimal("0"))


class StockMovement(Base):
    """Журнал всех изменений остатка — по нему всегда можно понять, откуда взялась цифра."""
    __tablename__ = "stock_movements"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"))
    delta: Mapped[Decimal] = mapped_column(Qty)
    reason: Mapped[str] = mapped_column(String(30))  # sale, return, import, supplier_order, inventory, transfer_in, transfer_out, writeoff, manual
    ref_id: Mapped[int | None] = mapped_column(Integer)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


# ---------- складские документы ----------

class StockDocument(Base):
    """Один тип документа на заказ поставщику, инвентаризацию, перемещение, списание и переоценку."""
    __tablename__ = "stock_documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # supplier_order, inventory, transfer, writeoff, repricing
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft, completed, cancelled
    store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"))
    to_store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"))  # для перемещения
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    reason: Mapped[str | None] = mapped_column(String(300))
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    items: Mapped[list["StockDocumentItem"]] = relationship(cascade="all, delete-orphan", lazy="selectin")


class StockDocumentItem(Base):
    __tablename__ = "stock_document_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("stock_documents.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    qty: Mapped[Decimal] = mapped_column(Qty, default=Decimal("0"))  # кол-во; для инвентаризации — посчитано
    expected_qty: Mapped[Decimal | None] = mapped_column(Qty)  # инвентаризация: было по учёту
    price: Mapped[Decimal | None] = mapped_column(Money)  # закупочная цена или новая розничная цена
    old_price: Mapped[Decimal | None] = mapped_column(Money)


# ---------- клиенты ----------

class ClientGroup(Base):
    __tablename__ = "client_groups"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    discount_percent: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))


class Client(Base):
    __tablename__ = "clients"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(50), index=True)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("client_groups.id"))
    tags: Mapped[list] = mapped_column(JSON, default=list)
    birth_date: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text)
    bonus_balance: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    debt_balance: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    sms_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class DebtPayment(Base):
    __tablename__ = "debt_payments"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"))
    amount: Mapped[Decimal] = mapped_column(Money)
    method: Mapped[str] = mapped_column(String(20))  # cash, card
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


# ---------- маркетинг ----------

class Promotion(Base):
    __tablename__ = "promotions"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    discount_percent: Mapped[Decimal] = mapped_column(Money)
    product_ids: Mapped[list] = mapped_column(JSON, default=list)
    category_ids: Mapped[list] = mapped_column(JSON, default=list)  # пусто и там и там = на все товары
    store_ids: Mapped[list] = mapped_column(JSON, default=list)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class PromoCode(Base):
    __tablename__ = "promo_codes"
    __table_args__ = (UniqueConstraint("company_id", "code"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    code: Mapped[str] = mapped_column(String(50))
    discount_percent: Mapped[Decimal | None] = mapped_column(Money)
    discount_amount: Mapped[Decimal | None] = mapped_column(Money)
    min_total: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    max_uses: Mapped[int | None] = mapped_column(Integer)
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class SmsCampaign(Base):
    __tablename__ = "sms_campaigns"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    text: Mapped[str] = mapped_column(Text)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("client_groups.id"))
    tag: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued, sent, failed
    recipients: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


# ---------- продажи ----------

class Sale(Base):
    __tablename__ = "sales"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    seller_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="completed")  # held, completed, cancelled
    subtotal: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))  # до скидок
    discount: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))  # к оплате
    returned_total: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    promo_code_id: Mapped[int | None] = mapped_column(ForeignKey("promo_codes.id"))
    bonus_earned: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    items: Mapped[list["SaleItem"]] = relationship(cascade="all, delete-orphan", lazy="selectin")
    payments: Mapped[list["Payment"]] = relationship(cascade="all, delete-orphan", lazy="selectin")


class SaleItem(Base):
    __tablename__ = "sale_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(ForeignKey("sales.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    name: Mapped[str] = mapped_column(String(300))
    is_service: Mapped[bool] = mapped_column(Boolean, default=False)
    qty: Mapped[Decimal] = mapped_column(Qty)
    price: Mapped[Decimal] = mapped_column(Money)  # цена за единицу до скидки
    cost_price: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    discount: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))  # скидка на всю строку
    total: Mapped[Decimal] = mapped_column(Money)
    returned_qty: Mapped[Decimal] = mapped_column(Qty, default=Decimal("0"))


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(ForeignKey("sales.id"), index=True)
    method: Mapped[str] = mapped_column(String(20))  # cash, card, debt, bonus
    amount: Mapped[Decimal] = mapped_column(Money)


class SaleReturn(Base):
    __tablename__ = "sale_returns"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    sale_id: Mapped[int] = mapped_column(ForeignKey("sales.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    amount: Mapped[Decimal] = mapped_column(Money)
    refund_method: Mapped[str] = mapped_column(String(20))  # cash, card, debt (уменьшить долг)
    items: Mapped[list] = mapped_column(JSON, default=list)  # [{sale_item_id, qty, amount}]
    reason: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class Target(Base):
    """Цель по чистой выручке за период — для всего бизнеса или одного магазина."""
    __tablename__ = "targets"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"))
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Money)
