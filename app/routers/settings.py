"""Настройки: компания, магазины, цели по выручке."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common import apply_patch, get_owned
from app.db import get_db
from app.models import Company, Store, Target, User
from app.schemas import CompanyOut, CompanyPatch, StoreIn, StoreOut, TargetIn, TargetOut
from app.security import current_user, require

router = APIRouter(prefix="/api", tags=["Настройки"])


@router.get("/company", response_model=CompanyOut)
def get_company(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return db.get(Company, user.company_id)


@router.patch("/company", response_model=CompanyOut)
def patch_company(data: CompanyPatch, user: User = Depends(require("settings.manage")), db: Session = Depends(get_db)):
    company = db.get(Company, user.company_id)
    apply_patch(company, data.model_dump(exclude_unset=True))
    db.commit()
    return company


@router.get("/stores", response_model=list[StoreOut])
def list_stores(user: User = Depends(current_user), db: Session = Depends(get_db)):
    stores = db.scalars(select(Store).where(Store.company_id == user.company_id).order_by(Store.id)).all()
    if user.is_owner or not user.store_ids:
        return stores
    return [s for s in stores if s.id in user.store_ids]


@router.post("/stores", response_model=StoreOut, status_code=201)
def create_store(data: StoreIn, user: User = Depends(require("settings.manage")), db: Session = Depends(get_db)):
    store = Store(company_id=user.company_id, **data.model_dump())
    db.add(store)
    db.commit()
    return store


@router.put("/stores/{store_id}", response_model=StoreOut)
def update_store(store_id: int, data: StoreIn, user: User = Depends(require("settings.manage")),
                 db: Session = Depends(get_db)):
    store = get_owned(db, Store, store_id, user, "Магазин")
    apply_patch(store, data.model_dump())
    db.commit()
    return store


@router.get("/targets", response_model=list[TargetOut])
def list_targets(user: User = Depends(require("reports.read")), db: Session = Depends(get_db)):
    return db.scalars(select(Target).where(Target.company_id == user.company_id).order_by(Target.period_start.desc())).all()


@router.post("/targets", response_model=TargetOut, status_code=201)
def create_target(data: TargetIn, user: User = Depends(require("settings.manage")), db: Session = Depends(get_db)):
    if data.store_id is not None:
        get_owned(db, Store, data.store_id, user, "Магазин")
    target = Target(company_id=user.company_id, **data.model_dump())
    db.add(target)
    db.commit()
    return target


@router.delete("/targets/{target_id}", status_code=204)
def delete_target(target_id: int, user: User = Depends(require("settings.manage")), db: Session = Depends(get_db)):
    db.delete(get_owned(db, Target, target_id, user, "Цель"))
    db.commit()


class BillzImportIn(BaseModel):
    secret_token: str = Field(min_length=20, max_length=2000)
    import_clients: bool = True
    step: str = "all"  # catalog, staff, people, sales (с month=ГГГГ-ММ), debts или all
    month: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}$")
    page: int = Field(default=1, ge=1)


@router.post("/import/billz")
def import_billz(data: BillzImportIn, user: User = Depends(require("settings.manage", "products.write")),
                 db: Session = Depends(get_db)):
    """Перенос данных из BILLZ по шагам. Ключ не сохраняется."""
    from app.services import billz_import
    return billz_import.run(db, user.company_id, data.secret_token, data.step, data.month, data.import_clients, data.page)
