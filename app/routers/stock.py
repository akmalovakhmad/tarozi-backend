"""Складские документы: заказ поставщику (приход), инвентаризация, перемещение, списание, переоценка.
Документ создаётся черновиком, остатки меняются только при проведении (POST .../complete)."""
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common import get_owned, get_store
from app.db import get_db
from app.models import Company, Product, StockDocument, StockDocumentItem, Supplier, User, now
from app.schemas import DocIn, DocKind, DocOut
from app.security import require
from app.services.stock import change_stock, get_level

router = APIRouter(prefix="/api/stock", tags=["Склад"])

TITLES = {"supplier_order": "заказ поставщику", "inventory": "инвентаризация", "transfer": "перемещение",
          "writeoff": "списание", "repricing": "переоценка"}


def _validate(db: Session, user: User, kind: str, data: DocIn):
    if kind != "repricing":
        if not data.store_id:
            raise HTTPException(422, "Укажите магазин")
        get_store(db, data.store_id, user)
    if kind == "transfer":
        if not data.to_store_id or data.to_store_id == data.store_id:
            raise HTTPException(422, "Укажите другой магазин, куда перемещаете товар")
        get_store(db, data.to_store_id, user)
    if kind == "supplier_order" and data.supplier_id:
        get_owned(db, Supplier, data.supplier_id, user, "Поставщик")
    if kind == "writeoff" and not data.reason:
        raise HTTPException(422, "Укажите причину списания")
    for it in data.items:
        p = get_owned(db, Product, it.product_id, user, "Товар")
        if kind == "repricing":
            if it.price is None:
                raise HTTPException(422, f"Укажите новую цену для «{p.name}»")
        else:
            if p.is_service:
                raise HTTPException(422, f"«{p.name}» — услуга, у неё нет остатка")
            if kind != "inventory" and it.qty <= 0:
                raise HTTPException(422, f"Количество для «{p.name}» должно быть больше нуля")


@router.get("/{kind}", response_model=list[DocOut])
def list_docs(kind: DocKind, status: str | None = None, store_id: int | None = None,
              limit: int = Query(100, le=500), user: User = Depends(require("stock.manage")),
              db: Session = Depends(get_db)):
    q = select(StockDocument).where(StockDocument.company_id == user.company_id, StockDocument.kind == kind)
    if status:
        q = q.where(StockDocument.status == status)
    if store_id:
        q = q.where((StockDocument.store_id == store_id) | (StockDocument.to_store_id == store_id))
    return db.scalars(q.order_by(StockDocument.id.desc()).limit(limit)).all()


@router.post("/{kind}", response_model=DocOut, status_code=201)
def create_doc(kind: DocKind, data: DocIn, user: User = Depends(require("stock.manage")), db: Session = Depends(get_db)):
    _validate(db, user, kind, data)
    doc = StockDocument(company_id=user.company_id, kind=kind, store_id=data.store_id, to_store_id=data.to_store_id,
                        supplier_id=data.supplier_id, reason=data.reason, created_by=user.id)
    for it in data.items:
        doc.items.append(StockDocumentItem(product_id=it.product_id, qty=it.qty, price=it.price))
    db.add(doc)
    db.commit()
    return doc


def _doc(db, user, kind, doc_id) -> StockDocument:
    doc = get_owned(db, StockDocument, doc_id, user, "Документ")
    if doc.kind != kind:
        raise HTTPException(404, "Документ не найден")
    return doc


@router.get("/{kind}/{doc_id}", response_model=DocOut)
def get_doc(kind: DocKind, doc_id: int, user: User = Depends(require("stock.manage")), db: Session = Depends(get_db)):
    return _doc(db, user, kind, doc_id)


@router.post("/{kind}/{doc_id}/complete", response_model=DocOut)
def complete_doc(kind: DocKind, doc_id: int, user: User = Depends(require("stock.manage")),
                 db: Session = Depends(get_db)):
    doc = _doc(db, user, kind, doc_id)
    if doc.status != "draft":
        raise HTTPException(409, f"Этот документ уже {'проведён' if doc.status == 'completed' else 'отменён'}")
    company = db.get(Company, user.company_id)
    allow_neg = company.allow_negative_stock
    common = dict(company_id=user.company_id, ref_id=doc.id, user_id=user.id)
    for it in doc.items:
        p = db.get(Product, it.product_id)
        qty = Decimal(it.qty)
        if kind == "supplier_order":
            change_stock(db, product=p, store_id=doc.store_id, delta=qty, reason="supplier_order",
                         allow_negative=True, **common)
            if it.price is not None:
                p.cost_price = it.price
        elif kind == "inventory":
            level = get_level(db, p.id, doc.store_id)
            it.expected_qty = level.qty
            diff = qty - Decimal(level.qty)
            if diff:
                change_stock(db, product=p, store_id=doc.store_id, delta=diff, reason="inventory",
                             allow_negative=True, **common)
        elif kind == "transfer":
            change_stock(db, product=p, store_id=doc.store_id, delta=-qty, reason="transfer_out",
                         allow_negative=allow_neg, **common)
            change_stock(db, product=p, store_id=doc.to_store_id, delta=qty, reason="transfer_in",
                         allow_negative=True, **common)
        elif kind == "writeoff":
            change_stock(db, product=p, store_id=doc.store_id, delta=-qty, reason="writeoff",
                         allow_negative=allow_neg, **common)
        elif kind == "repricing":
            it.old_price = p.retail_price
            p.retail_price = it.price
    doc.status, doc.completed_at = "completed", now()
    db.commit()
    return doc


@router.post("/{kind}/{doc_id}/cancel", response_model=DocOut)
def cancel_doc(kind: DocKind, doc_id: int, user: User = Depends(require("stock.manage")), db: Session = Depends(get_db)):
    doc = _doc(db, user, kind, doc_id)
    if doc.status != "draft":
        raise HTTPException(409, "Отменить можно только черновик")
    doc.status = "cancelled"
    db.commit()
    return doc
