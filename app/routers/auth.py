from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Company, Role, Store, User
from app.schemas import MeOut, RegisterIn, TokenOut
from app.security import create_token, current_user, hash_password, user_permissions, verify_password

router = APIRouter(prefix="/api/auth", tags=["Вход и регистрация"])

DEFAULT_ROLES = {
    "Кассир": ["products.read", "sales.create", "clients.read", "clients.write"],
    "Старший продавец": ["products.read", "sales.create", "sales.read", "sales.return", "clients.read",
                         "clients.write", "reports.read"],
    "Менеджер": ["products.read", "products.write", "stock.manage", "sales.create", "sales.read", "sales.return",
                 "clients.read", "clients.write", "marketing.manage", "reports.read"],
}


@router.post("/register", response_model=TokenOut, status_code=201)
def register(data: RegisterIn, db: Session = Depends(get_db)):
    """Регистрация нового бизнеса: компания, первый магазин, владелец и типовые роли."""
    if db.scalar(select(User).where(User.login == data.login)):
        raise HTTPException(409, "Этот логин уже занят")
    company = Company(name=data.company_name, currency=data.currency)
    db.add(company)
    db.flush()
    db.add(Store(company_id=company.id, name=data.store_name))
    for name, perms in DEFAULT_ROLES.items():
        db.add(Role(company_id=company.id, name=name, permissions=perms))
    owner = User(company_id=company.id, name=data.owner_name, login=data.login,
                 password_hash=hash_password(data.password), is_owner=True, store_ids=[])
    db.add(owner)
    db.commit()
    return TokenOut(access_token=create_token(owner))


@router.post("/login", response_model=TokenOut)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.login == form.username))
    if not user or not user.is_active or not verify_password(form.password, user.password_hash):
        raise HTTPException(401, "Неверный логин или пароль")
    return TokenOut(access_token=create_token(user))


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(current_user)):
    out = MeOut.model_validate(user)
    out.permissions = sorted(user_permissions(user))
    return out
