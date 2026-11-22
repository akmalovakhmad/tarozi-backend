"""Товары: каталог, категории, поставщики, импорт из CSV, журнал движений."""
import csv
import io
from decimal import Decimal, InvalidOperation
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.common import apply_patch, get_owned, get_store
from app.db import get_db
from app.models import Category, Company, Product, StockDocument, StockLevel, StockMovement, Supplier, SupplierPayment, User
from app.schemas import (CatalogStats, CategoryIn, CategoryOut, ImportResult, MovementOut, Page, ProductIn,
                         ProductOut, ProductPatch, SupplierIn, SupplierOut, SupplierPaymentIn, SupplierPaymentOut,
                         SupplierStatsOut)
from app.security import require
from app.services.stock import change_stock, doc_total

router = APIRouter(prefix="/api", tags=["Товары"])


# ---------- категории и поставщики ----------

@router.get("/categories", response_model=list[CategoryOut])
def list_categories(user: User = Depends(require("products.read")), db: Session = Depends(get_db)):
    return db.scalars(select(Category).where(Category.company_id == user.company_id).order_by(Category.name)).all()


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(data: CategoryIn, user: User = Depends(require("products.write")), db: Session = Depends(get_db)):
    if data.parent_id:
        get_owned(db, Category, data.parent_id, user, "Категория")
    cat = Category(company_id=user.company_id, **data.model_dump())
    db.add(cat)
    db.commit()
    return cat


@router.put("/categories/{cat_id}", response_model=CategoryOut)
def update_category(cat_id: int, data: CategoryIn, user: User = Depends(require("products.write")),
                    db: Session = Depends(get_db)):
    cat = get_owned(db, Category, cat_id, user, "Категория")
    if data.parent_id:
        get_owned(db, Category, data.parent_id, user, "Категория")
    apply_patch(cat, data.model_dump())
    db.commit()
    return cat


@router.get("/suppliers", response_model=list[SupplierStatsOut])
def list_suppliers(user: User = Depends(require("products.read")), db: Session = Depends(get_db)):
    """Поставщики с суммой заказов, возвратов, оплат и нашим долгом перед ними."""
    sups = db.scalars(select(Supplier).where(Supplier.company_id == user.company_id).order_by(Supplier.name)).all()
    docs = db.scalars(select(StockDocument).where(StockDocument.company_id == user.company_id, StockDocument.status == "completed",
                                                 StockDocument.kind.in_(["supplier_order", "supplier_return"]),
                                                 StockDocument.supplier_id.isnot(None))).all()
    paid = dict(db.execute(select(SupplierPayment.supplier_id, func.sum(SupplierPayment.amount))
                           .where(SupplierPayment.company_id == user.company_id).group_by(SupplierPayment.supplier_id)).all())
    out = []
    for sp in sups:
        orders = sum((doc_total(d) for d in docs if d.supplier_id == sp.id and d.kind == "supplier_order"), Decimal(0))
        rets = sum((doc_total(d) for d in docs if d.supplier_id == sp.id and d.kind == "supplier_return"), Decimal(0))
        items = sum((Decimal(i.qty) for d in docs if d.supplier_id == sp.id and d.kind == "supplier_order" for i in d.items), Decimal(0))
        pd = Decimal(paid.get(sp.id) or 0)
        out.append(SupplierStatsOut(id=sp.id, name=sp.name, phone=sp.phone, note=sp.note, orders_total=orders, returns_total=rets,
                                    paid_total=pd, debt=orders - rets - pd, items_count=items))
    return out


@router.get("/suppliers/{sup_id}/payments", response_model=list[SupplierPaymentOut])
def supplier_payments(sup_id: int, user: User = Depends(require("stock.manage")), db: Session = Depends(get_db)):
    get_owned(db, Supplier, sup_id, user, "Поставщик")
    return db.scalars(select(SupplierPayment).where(SupplierPayment.supplier_id == sup_id).order_by(SupplierPayment.id.desc())).all()


@router.post("/suppliers/{sup_id}/payments", response_model=SupplierPaymentOut, status_code=201)
def add_supplier_payment(sup_id: int, data: SupplierPaymentIn, user: User = Depends(require("stock.manage")),
                         db: Session = Depends(get_db)):
    """Оплата поставщику — целиком за заказ или частично, можно без привязки к заказу."""
    get_owned(db, Supplier, sup_id, user, "Поставщик")
    if data.document_id:
        doc = get_owned(db, StockDocument, data.document_id, user, "Заказ")
        if doc.supplier_id != sup_id or doc.kind != "supplier_order":
            raise HTTPException(422, "Этот заказ относится к другому поставщику")
    p = SupplierPayment(company_id=user.company_id, supplier_id=sup_id, document_id=data.document_id, amount=data.amount,
                        method=data.method, note=data.note, user_id=user.id)
    db.add(p)
    db.commit()
    return p


@router.post("/suppliers", response_model=SupplierOut, status_code=201)
def create_supplier(data: SupplierIn, user: User = Depends(require("products.write")), db: Session = Depends(get_db)):
    sup = Supplier(company_id=user.company_id, **data.model_dump())
    db.add(sup)
    db.commit()
    return sup


@router.put("/suppliers/{sup_id}", response_model=SupplierOut)
def update_supplier(sup_id: int, data: SupplierIn, user: User = Depends(require("products.write")),
                    db: Session = Depends(get_db)):
    sup = get_owned(db, Supplier, sup_id, user, "Поставщик")
    apply_patch(sup, data.model_dump())
    db.commit()
    return sup


# ---------- каталог ----------

def _with_stock(db: Session, products: list[Product]) -> list[ProductOut]:
    ids = [p.id for p in products]
    levels = db.execute(select(StockLevel.product_id, StockLevel.store_id, StockLevel.qty)
                        .where(StockLevel.product_id.in_(ids))).all() if ids else []
    by_product: dict[int, dict[int, Decimal]] = {}
    for pid, sid, qty in levels:
        by_product.setdefault(pid, {})[sid] = qty
    out = []
    for p in products:
        o = ProductOut.model_validate(p)
        o.stock = by_product.get(p.id, {})
        o.stock_total = sum(o.stock.values(), Decimal("0"))
        out.append(o)
    return out


def _stock_subq(store_id: int | None):
    q = select(StockLevel.product_id, func.sum(StockLevel.qty).label("qty")).group_by(StockLevel.product_id)
    if store_id:
        q = q.where(StockLevel.store_id == store_id)
    return q.subquery()


@router.get("/products", response_model=Page)
def list_products(
    status: Literal["all", "active", "inactive", "low", "zero"] = "all",
    q: str | None = Query(None, description="Поиск по названию, артикулу, штрихкоду"),
    category_id: int | None = None,
    supplier_id: int | None = None,
    store_id: int | None = Query(None, description="Считать остаток только в этом магазине"),
    page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500),
    user: User = Depends(require("products.read")), db: Session = Depends(get_db),
):
    company = db.get(Company, user.company_id)
    sq = _stock_subq(store_id)
    stock = func.coalesce(sq.c.qty, 0)
    query = select(Product).outerjoin(sq, sq.c.product_id == Product.id).where(Product.company_id == user.company_id)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Product.name.ilike(like), Product.sku.ilike(like), Product.barcode == q.strip()))
    if category_id:
        query = query.where(Product.category_id == category_id)
    if supplier_id:
        query = query.where(Product.supplier_id == supplier_id)
    if status == "active":
        query = query.where(Product.is_active.is_(True))
    elif status == "inactive":
        query = query.where(Product.is_active.is_(False))
    elif status == "low":
        query = query.where(Product.is_service.is_(False), stock > 0, stock <= company.low_stock_threshold)
    elif status == "zero":
        query = query.where(Product.is_service.is_(False), stock <= 0)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(Product.name).offset((page - 1) * size).limit(size)).all()
    return Page(total=total, items=[o.model_dump(mode="json") for o in _with_stock(db, rows)])


@router.get("/products/stats", response_model=CatalogStats)
def catalog_stats(store_id: int | None = None, user: User = Depends(require("products.read")),
                  db: Session = Depends(get_db)):
    """Цифры для вкладок каталога: все, активные, неактивные, малый и нулевой остаток."""
    company = db.get(Company, user.company_id)
    sq = _stock_subq(store_id)
    stock = func.coalesce(sq.c.qty, 0)
    base = select(func.count(Product.id)).outerjoin(sq, sq.c.product_id == Product.id) \
        .where(Product.company_id == user.company_id)
    goods = base.where(Product.is_service.is_(False))
    return CatalogStats(
        all=db.scalar(base), active=db.scalar(base.where(Product.is_active.is_(True))),
        inactive=db.scalar(base.where(Product.is_active.is_(False))),
        low_stock=db.scalar(goods.where(stock > 0, stock <= company.low_stock_threshold)),
        zero_stock=db.scalar(goods.where(stock <= 0)))


@router.get("/products/barcode/{code}", response_model=ProductOut)
def by_barcode(code: str, user: User = Depends(require("products.read")), db: Session = Depends(get_db)):
    """Для сканера на кассе."""
    p = db.scalar(select(Product).where(Product.company_id == user.company_id,
                                        or_(Product.barcode == code, Product.sku == code)))
    if not p:
        raise HTTPException(404, f"Товар со штрихкодом {code} не найден")
    return _with_stock(db, [p])[0]


@router.get("/products/{product_id}", response_model=ProductOut)
def get_product(product_id: int, user: User = Depends(require("products.read")), db: Session = Depends(get_db)):
    return _with_stock(db, [get_owned(db, Product, product_id, user, "Товар")])[0]


def _check_product_refs(db, user, category_id, supplier_id):
    if category_id:
        get_owned(db, Category, category_id, user, "Категория")
    if supplier_id:
        get_owned(db, Supplier, supplier_id, user, "Поставщик")


def _check_sku(db, user, sku, exclude_id=None):
    if not sku:
        return
    q = select(Product.id).where(Product.company_id == user.company_id, Product.sku == sku)
    if exclude_id:
        q = q.where(Product.id != exclude_id)
    if db.scalar(q):
        raise HTTPException(409, f"Артикул {sku} уже есть у другого товара")


@router.post("/products", response_model=ProductOut, status_code=201)
def create_product(data: ProductIn, user: User = Depends(require("products.write")), db: Session = Depends(get_db)):
    _check_product_refs(db, user, data.category_id, data.supplier_id)
    _check_sku(db, user, data.sku)
    p = Product(company_id=user.company_id, **data.model_dump())
    db.add(p)
    db.commit()
    return _with_stock(db, [p])[0]


@router.patch("/products/{product_id}", response_model=ProductOut)
def update_product(product_id: int, data: ProductPatch, user: User = Depends(require("products.write")),
                   db: Session = Depends(get_db)):
    """Розничная цена меняется только через документ переоценки, чтобы осталась история."""
    p = get_owned(db, Product, product_id, user, "Товар")
    patch = data.model_dump(exclude_unset=True)
    _check_product_refs(db, user, patch.get("category_id"), patch.get("supplier_id"))
    _check_sku(db, user, patch.get("sku"), p.id)
    apply_patch(p, patch)
    db.commit()
    return _with_stock(db, [p])[0]


@router.get("/products/{product_id}/movements", response_model=list[MovementOut])
def product_movements(product_id: int, store_id: int | None = None, limit: int = Query(100, le=1000),
                      user: User = Depends(require("products.read")), db: Session = Depends(get_db)):
    get_owned(db, Product, product_id, user, "Товар")
    q = select(StockMovement).where(StockMovement.product_id == product_id)
    if store_id:
        q = q.where(StockMovement.store_id == store_id)
    return db.scalars(q.order_by(StockMovement.id.desc()).limit(limit)).all()


# ---------- импорт ----------

def _dec(v: str | None, field: str, row: int) -> Decimal | None:
    if v is None or v.strip() == "":
        return None
    try:
        return Decimal(v.strip().replace(",", ".").replace(" ", ""))
    except InvalidOperation:
        raise ValueError(f"строка {row}: «{field}» должно быть числом, а не «{v}»")


@router.post("/products/import", response_model=ImportResult)
async def import_products(store_id: int, file: UploadFile = File(...),
                          user: User = Depends(require("products.write", "stock.manage")),
                          db: Session = Depends(get_db)):
    """CSV с колонками: name, sku, barcode, category, supplier, cost_price, retail_price, qty.
    Товар ищется по артикулу (sku): есть — обновляется, нет — создаётся. qty добавляется к остатку в магазине."""
    get_store(db, store_id, user)
    company = db.get(Company, user.company_id)
    raw = (await file.read()).decode("utf-8-sig")
    sample = raw[:2000]
    delimiter = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(raw), delimiter=delimiter)
    if not reader.fieldnames or "name" not in [f.strip() for f in reader.fieldnames]:
        raise HTTPException(422, "В файле нет колонки name. Нужные колонки: name, sku, barcode, category, supplier, "
                                 "cost_price, retail_price, qty")
    cats = {c.name.lower(): c for c in db.scalars(select(Category).where(Category.company_id == user.company_id))}
    sups = {s.name.lower(): s for s in db.scalars(select(Supplier).where(Supplier.company_id == user.company_id))}
    created = updated = 0
    errors: list[str] = []
    for n, row in enumerate(reader, start=2):
        row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        try:
            if not row.get("name"):
                raise ValueError(f"строка {n}: пустое название")
            cost, price, qty = (_dec(row.get("cost_price"), "cost_price", n), _dec(row.get("retail_price"), "retail_price", n),
                                _dec(row.get("qty"), "qty", n))
        except ValueError as e:
            errors.append(str(e))
            continue
        cat = sup = None
        if row.get("category"):
            cat = cats.get(row["category"].lower())
            if not cat:
                cat = Category(company_id=user.company_id, name=row["category"])
                db.add(cat)
                db.flush()
                cats[cat.name.lower()] = cat
        if row.get("supplier"):
            sup = sups.get(row["supplier"].lower())
            if not sup:
                sup = Supplier(company_id=user.company_id, name=row["supplier"])
                db.add(sup)
                db.flush()
                sups[sup.name.lower()] = sup
        sku = row.get("sku") or None
        p = db.scalar(select(Product).where(Product.company_id == user.company_id, Product.sku == sku)) if sku else None
        if p:
            updated += 1
        else:
            p = Product(company_id=user.company_id, name=row["name"], sku=sku)
            db.add(p)
            created += 1
        p.name = row["name"]
        p.barcode = row.get("barcode") or p.barcode
        p.category_id = cat.id if cat else p.category_id
        p.supplier_id = sup.id if sup else p.supplier_id
        if cost is not None:
            p.cost_price = cost
        if price is not None:
            p.retail_price = price
        db.flush()
        if qty:
            change_stock(db, company_id=user.company_id, product=p, store_id=store_id, delta=qty, reason="import",
                         ref_id=None, user_id=user.id, allow_negative=company.allow_negative_stock)
    db.commit()
    return ImportResult(created=created, updated=updated, errors=errors)
