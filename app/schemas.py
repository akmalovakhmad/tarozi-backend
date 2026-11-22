"""Схемы запросов и ответов API. Деньги внутри — Decimal, в JSON уходят числом."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

Num = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]
Pos = Annotated[Decimal, Field(gt=0), PlainSerializer(float, return_type=float, when_used="json")]
NonNeg = Annotated[Decimal, Field(ge=0), PlainSerializer(float, return_type=float, when_used="json")]


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel):
    total: int
    items: list


# ---------- auth / компания ----------

class RegisterIn(BaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    store_name: str = Field(min_length=1, max_length=200)
    owner_name: str = Field(min_length=1, max_length=200)
    login: str = Field(min_length=3, max_length=100)
    password: str = Field(min_length=8, max_length=200)
    currency: str = "USD"


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MeOut(Out):
    id: int
    name: str
    login: str
    company_id: int
    is_owner: bool
    role_id: int | None
    store_ids: list[int]
    permissions: list[str] = []


class CompanyOut(Out):
    id: int
    name: str
    currency: str
    loyalty_percent: Num
    max_bonus_payment_percent: Num
    low_stock_threshold: Num
    allow_negative_stock: bool
    utc_offset_minutes: int


class CompanyPatch(BaseModel):
    name: str | None = None
    currency: str | None = None
    loyalty_percent: NonNeg | None = None
    max_bonus_payment_percent: Annotated[Decimal, Field(ge=0, le=100)] | None = None
    low_stock_threshold: NonNeg | None = None
    allow_negative_stock: bool | None = None
    utc_offset_minutes: int | None = Field(default=None, ge=-720, le=840)


class StoreIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    address: str | None = None
    is_active: bool = True


class StoreOut(Out):
    id: int
    name: str
    address: str | None
    is_active: bool


class TargetIn(BaseModel):
    store_id: int | None = None
    period_start: date
    period_end: date
    amount: Pos


class TargetOut(Out):
    id: int
    store_id: int | None
    period_start: date
    period_end: date
    amount: Num


# ---------- сотрудники ----------

class RoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    permissions: list[str] = []


class RoleOut(Out):
    id: int
    name: str
    permissions: list[str]


class UserIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    login: str = Field(min_length=3, max_length=100)
    password: str = Field(min_length=8, max_length=200)
    role_id: int | None = None
    store_ids: list[int] = []


class UserPatch(BaseModel):
    name: str | None = None
    password: str | None = Field(default=None, min_length=8)
    role_id: int | None = None
    store_ids: list[int] | None = None
    is_active: bool | None = None


class UserOut(Out):
    id: int
    name: str
    login: str
    role_id: int | None
    store_ids: list[int]
    is_owner: bool
    is_active: bool


# ---------- товары ----------

class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: int | None = None


class CategoryOut(Out):
    id: int
    name: str
    parent_id: int | None


class SupplierIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    phone: str | None = None
    note: str | None = None


class SupplierOut(Out):
    id: int
    name: str
    phone: str | None
    note: str | None


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    sku: str | None = None
    barcode: str | None = None
    category_id: int | None = None
    supplier_id: int | None = None
    unit: str = "шт"
    is_service: bool = False
    is_active: bool = True
    cost_price: NonNeg = Decimal("0")
    retail_price: NonNeg = Decimal("0")


class ProductPatch(BaseModel):
    name: str | None = None
    sku: str | None = None
    barcode: str | None = None
    category_id: int | None = None
    supplier_id: int | None = None
    unit: str | None = None
    is_service: bool | None = None
    is_active: bool | None = None
    cost_price: NonNeg | None = None


class ProductOut(Out):
    id: int
    name: str
    sku: str | None
    barcode: str | None
    category_id: int | None
    supplier_id: int | None
    unit: str
    is_service: bool
    is_active: bool
    cost_price: Num
    retail_price: Num
    stock: dict[int, Num] = {}  # store_id -> остаток
    stock_total: Num = Decimal("0")


class CatalogStats(BaseModel):
    all: int
    active: int
    inactive: int
    low_stock: int
    zero_stock: int


# ---------- складские документы ----------

DocKind = Literal["supplier_order", "inventory", "transfer", "writeoff", "repricing"]


class DocItemIn(BaseModel):
    product_id: int
    qty: NonNeg = Decimal("0")
    price: NonNeg | None = None


class DocIn(BaseModel):
    store_id: int | None = None
    to_store_id: int | None = None
    supplier_id: int | None = None
    reason: str | None = None
    items: list[DocItemIn] = Field(min_length=1)


class DocItemOut(Out):
    id: int
    product_id: int
    qty: Num
    expected_qty: Num | None
    price: Num | None
    old_price: Num | None


class DocOut(Out):
    id: int
    kind: str
    status: str
    store_id: int | None
    to_store_id: int | None
    supplier_id: int | None
    reason: str | None
    created_by: int | None
    created_at: datetime
    completed_at: datetime | None
    items: list[DocItemOut]


class MovementOut(Out):
    id: int
    product_id: int
    store_id: int
    delta: Num
    reason: str
    ref_id: int | None
    user_id: int | None
    created_at: datetime


class ImportResult(BaseModel):
    created: int
    updated: int
    errors: list[str]


# ---------- клиенты ----------

class ClientGroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    discount_percent: Annotated[Decimal, Field(ge=0, le=100)] = Decimal("0")


class ClientGroupOut(Out):
    id: int
    name: str
    discount_percent: Num


class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    phone: str | None = None
    group_id: int | None = None
    tags: list[str] = []
    birth_date: date | None = None
    note: str | None = None
    sms_allowed: bool = True


class ClientPatch(BaseModel):
    name: str | None = None
    phone: str | None = None
    group_id: int | None = None
    tags: list[str] | None = None
    birth_date: date | None = None
    note: str | None = None
    sms_allowed: bool | None = None


class ClientOut(Out):
    id: int
    name: str
    phone: str | None
    group_id: int | None
    tags: list[str]
    birth_date: date | None
    note: str | None
    bonus_balance: Num
    debt_balance: Num
    sms_allowed: bool
    created_at: datetime


class DebtPaymentIn(BaseModel):
    amount: Pos
    method: Literal["cash", "card"]
    store_id: int | None = None


class DebtPaymentOut(Out):
    id: int
    client_id: int
    amount: Num
    method: str
    created_at: datetime


# ---------- маркетинг ----------

class PromotionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    discount_percent: Annotated[Decimal, Field(gt=0, le=100)]
    product_ids: list[int] = []
    category_ids: list[int] = []
    store_ids: list[int] = []
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    is_active: bool = True


class PromotionOut(Out):
    id: int
    name: str
    discount_percent: Num
    product_ids: list[int]
    category_ids: list[int]
    store_ids: list[int]
    starts_at: datetime | None
    ends_at: datetime | None
    is_active: bool


class PromoCodeIn(BaseModel):
    code: str = Field(min_length=2, max_length=50)
    discount_percent: Annotated[Decimal, Field(gt=0, le=100)] | None = None
    discount_amount: Pos | None = None
    min_total: NonNeg = Decimal("0")
    max_uses: int | None = Field(default=None, ge=1)
    expires_at: datetime | None = None
    is_active: bool = True


class PromoCodeOut(Out):
    id: int
    code: str
    discount_percent: Num | None
    discount_amount: Num | None
    min_total: Num
    max_uses: int | None
    used_count: int
    expires_at: datetime | None
    is_active: bool


class SmsIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    group_id: int | None = None
    tag: str | None = None


class SmsOut(Out):
    id: int
    text: str
    group_id: int | None
    tag: str | None
    status: str
    recipients: list[str]
    created_at: datetime


# ---------- продажи ----------

PayMethod = Literal["cash", "card", "debt"]


class SaleItemIn(BaseModel):
    product_id: int
    qty: Pos
    price: NonNeg | None = None  # своя цена (нужно право products.write), иначе розничная


class PaymentIn(BaseModel):
    method: PayMethod
    amount: Pos


class SaleIn(BaseModel):
    store_id: int
    client_id: int | None = None
    items: list[SaleItemIn] = Field(min_length=1)
    payments: list[PaymentIn] = []
    promo_code: str | None = None
    bonus_to_use: NonNeg = Decimal("0")
    hold: bool = False  # True = отложить чек (без оплаты и списания со склада)
    comment: str | None = None


class SaleQuoteOut(BaseModel):
    subtotal: Num
    discount: Num
    total: Num
    bonus_available: Num
    bonus_max_for_this_sale: Num
    items: list[dict]


class CompleteHeldIn(BaseModel):
    payments: list[PaymentIn] = []
    bonus_to_use: NonNeg = Decimal("0")


class SaleItemOut(Out):
    id: int
    product_id: int
    name: str
    qty: Num
    price: Num
    discount: Num
    total: Num
    returned_qty: Num


class PaymentOut(Out):
    method: str
    amount: Num


class SaleOut(Out):
    id: int
    number: int
    store_id: int
    seller_id: int
    client_id: int | None
    status: str
    subtotal: Num
    discount: Num
    total: Num
    returned_total: Num
    bonus_earned: Num
    comment: str | None
    created_at: datetime
    items: list[SaleItemOut]
    payments: list[PaymentOut]


class ReturnItemIn(BaseModel):
    sale_item_id: int
    qty: Pos


class ReturnIn(BaseModel):
    items: list[ReturnItemIn] = Field(min_length=1)
    refund_method: Literal["cash", "card", "debt"]
    reason: str | None = None


class ReturnOut(Out):
    id: int
    sale_id: int
    amount: Num
    refund_method: str
    items: list[dict]
    reason: str | None
    created_at: datetime
