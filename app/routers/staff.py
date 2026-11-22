"""Управление: сотрудники и роли."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common import get_owned
from app.db import get_db
from app.models import Role, Store, User
from app.schemas import RoleIn, RoleOut, UserIn, UserOut, UserPatch
from app.security import PERMISSIONS, hash_password, require

router = APIRouter(prefix="/api", tags=["Сотрудники"])


@router.get("/permissions")
def list_permissions(_: User = Depends(require("staff.manage"))):
    """Все права, которые можно выдать роли, с понятными названиями."""
    return [{"key": k, "title": v} for k, v in PERMISSIONS.items()]


def _check_perms(perms: list[str]):
    bad = [p for p in perms if p not in PERMISSIONS]
    if bad:
        raise HTTPException(422, f"Неизвестные права: {', '.join(bad)}")


@router.get("/roles", response_model=list[RoleOut])
def list_roles(user: User = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    return db.scalars(select(Role).where(Role.company_id == user.company_id).order_by(Role.id)).all()


@router.post("/roles", response_model=RoleOut, status_code=201)
def create_role(data: RoleIn, user: User = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    _check_perms(data.permissions)
    role = Role(company_id=user.company_id, name=data.name, permissions=data.permissions)
    db.add(role)
    db.commit()
    return role


@router.put("/roles/{role_id}", response_model=RoleOut)
def update_role(role_id: int, data: RoleIn, user: User = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    _check_perms(data.permissions)
    role = get_owned(db, Role, role_id, user, "Роль")
    role.name, role.permissions = data.name, data.permissions
    db.commit()
    return role


@router.delete("/roles/{role_id}", status_code=204)
def delete_role(role_id: int, user: User = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    role = get_owned(db, Role, role_id, user, "Роль")
    if db.scalar(select(User).where(User.role_id == role.id)):
        raise HTTPException(409, "У роли есть сотрудники. Сначала назначьте им другую роль")
    db.delete(role)
    db.commit()


def _check_refs(db: Session, user: User, role_id: int | None, store_ids: list[int] | None):
    if role_id is not None:
        get_owned(db, Role, role_id, user, "Роль")
    for sid in store_ids or []:
        get_owned(db, Store, sid, user, "Магазин")


@router.get("/users", response_model=list[UserOut])
def list_users(user: User = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    return db.scalars(select(User).where(User.company_id == user.company_id).order_by(User.id)).all()


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(data: UserIn, user: User = Depends(require("staff.manage")), db: Session = Depends(get_db)):
    if db.scalar(select(User).where(User.login == data.login)):
        raise HTTPException(409, "Этот логин уже занят")
    _check_refs(db, user, data.role_id, data.store_ids)
    new = User(company_id=user.company_id, name=data.name, login=data.login, role_id=data.role_id,
               store_ids=data.store_ids, password_hash=hash_password(data.password))
    db.add(new)
    db.commit()
    return new


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, data: UserPatch, user: User = Depends(require("staff.manage")),
                db: Session = Depends(get_db)):
    target = get_owned(db, User, user_id, user, "Сотрудник")
    if target.is_owner and data.is_active is False:
        raise HTTPException(422, "Владельца нельзя отключить")
    patch = data.model_dump(exclude_unset=True)
    _check_refs(db, user, patch.get("role_id"), patch.get("store_ids"))
    if "password" in patch:
        target.password_hash = hash_password(patch.pop("password"))
    for k, v in patch.items():
        setattr(target, k, v)
    db.commit()
    return target
