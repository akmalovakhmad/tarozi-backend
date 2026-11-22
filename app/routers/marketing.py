"""Маркетинг: акции (скидка на товары/категории), промокоды, SMS-рассылки."""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common import apply_patch, get_owned
from app.db import SessionLocal, get_db
from app.models import Client, ClientGroup, PromoCode, Promotion, SmsCampaign, User
from app.schemas import PromoCodeIn, PromoCodeOut, PromotionIn, PromotionOut, SmsIn, SmsOut
from app.security import require
from app.services.sms import send_sms

router = APIRouter(prefix="/api/marketing", tags=["Маркетинг"])


@router.get("/promotions", response_model=list[PromotionOut])
def list_promotions(user: User = Depends(require("marketing.manage")), db: Session = Depends(get_db)):
    return db.scalars(select(Promotion).where(Promotion.company_id == user.company_id).order_by(Promotion.id.desc())).all()


@router.post("/promotions", response_model=PromotionOut, status_code=201)
def create_promotion(data: PromotionIn, user: User = Depends(require("marketing.manage")), db: Session = Depends(get_db)):
    if data.starts_at and data.ends_at and data.ends_at < data.starts_at:
        raise HTTPException(422, "Акция заканчивается раньше, чем начинается")
    p = Promotion(company_id=user.company_id, **data.model_dump())
    db.add(p)
    db.commit()
    return p


@router.put("/promotions/{promo_id}", response_model=PromotionOut)
def update_promotion(promo_id: int, data: PromotionIn, user: User = Depends(require("marketing.manage")),
                     db: Session = Depends(get_db)):
    p = get_owned(db, Promotion, promo_id, user, "Акция")
    apply_patch(p, data.model_dump())
    db.commit()
    return p


@router.get("/promo-codes", response_model=list[PromoCodeOut])
def list_codes(user: User = Depends(require("marketing.manage")), db: Session = Depends(get_db)):
    return db.scalars(select(PromoCode).where(PromoCode.company_id == user.company_id).order_by(PromoCode.id.desc())).all()


@router.post("/promo-codes", response_model=PromoCodeOut, status_code=201)
def create_code(data: PromoCodeIn, user: User = Depends(require("marketing.manage")), db: Session = Depends(get_db)):
    if bool(data.discount_percent) == bool(data.discount_amount):
        raise HTTPException(422, "Укажите что-то одно: скидку в процентах или суммой")
    code = data.code.strip().upper()
    if db.scalar(select(PromoCode.id).where(PromoCode.company_id == user.company_id, func.upper(PromoCode.code) == code)):
        raise HTTPException(409, "Такой промокод уже есть")
    p = PromoCode(company_id=user.company_id, **{**data.model_dump(), "code": code})
    db.add(p)
    db.commit()
    return p


@router.patch("/promo-codes/{code_id}/active", response_model=PromoCodeOut)
def toggle_code(code_id: int, is_active: bool, user: User = Depends(require("marketing.manage")),
                db: Session = Depends(get_db)):
    p = get_owned(db, PromoCode, code_id, user, "Промокод")
    p.is_active = is_active
    db.commit()
    return p


@router.get("/sms", response_model=list[SmsOut])
def list_sms(user: User = Depends(require("marketing.manage")), db: Session = Depends(get_db)):
    return db.scalars(select(SmsCampaign).where(SmsCampaign.company_id == user.company_id).order_by(SmsCampaign.id.desc())).all()


def _deliver(campaign_id: int):
    db = SessionLocal()
    try:
        c = db.get(SmsCampaign, campaign_id)
        ok = all(send_sms(phone, c.text) for phone in c.recipients)
        c.status = "sent" if ok else "failed"
        db.commit()
    finally:
        db.close()


@router.post("/sms", response_model=SmsOut, status_code=201)
def create_sms(data: SmsIn, background: BackgroundTasks, user: User = Depends(require("marketing.manage")),
               db: Session = Depends(get_db)):
    """Рассылка всем клиентам с телефоном и согласием на SMS; можно сузить по группе или тегу."""
    if data.group_id:
        get_owned(db, ClientGroup, data.group_id, user, "Группа")
    q = select(Client).where(Client.company_id == user.company_id, Client.sms_allowed.is_(True), Client.phone.isnot(None))
    if data.group_id:
        q = q.where(Client.group_id == data.group_id)
    clients = [c for c in db.scalars(q) if not data.tag or data.tag in (c.tags or [])]
    if not clients:
        raise HTTPException(422, "Нет получателей: у выбранных клиентов нет телефона или они отказались от SMS")
    c = SmsCampaign(company_id=user.company_id, text=data.text, group_id=data.group_id, tag=data.tag,
                    recipients=[cl.phone for cl in clients], created_by=user.id)
    db.add(c)
    db.commit()
    background.add_task(_deliver, c.id)
    return c
