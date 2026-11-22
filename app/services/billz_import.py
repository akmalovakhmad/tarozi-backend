"""Перенос данных из BILLZ (api-admin.billz.ai) в Тарози: магазины, категории, товары с ценами и остатками, клиенты.

Ключ BILLZ (secret_token) используется только на время импорта и нигде не сохраняется.
Повторный запуск безопасен: товары сопоставляются по артикулу/штрихкоду, клиенты — по телефону,
остатки выставляются равными остаткам в BILLZ (через журнал движений с причиной «import»)."""
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Category, Client, Company, Product, Store
from app.services.stock import change_stock, get_level

HOST = "https://api-admin.billz.ai"
PAGE = 500


def _http(method: str, path: str, token: str | None = None, body: dict | None = None, params: dict | None = None) -> dict:
    url = HOST + path + ("?" + urllib.parse.urlencode(params) if params else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", "Accept": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(422, "BILLZ не принял ключ. Проверьте, что скопировали его целиком, и что он не отозван")
        raise HTTPException(502, f"BILLZ ответил ошибкой {e.code} на {path}")
    except urllib.error.URLError:
        raise HTTPException(502, "Не удалось связаться с BILLZ. Попробуйте ещё раз через минуту")


# подменяется в тестах
fetch = _http


def _dec(v) -> Decimal:
    try:
        return Decimal(str(v)) if v not in (None, "") else Decimal(0)
    except InvalidOperation:
        return Decimal(0)


def _pages(token: str, path: str, key: str) -> list[dict]:
    out, page = [], 1
    while True:
        r = fetch("GET", path, token, params={"page": page, "limit": PAGE})
        r = r.get("data", r) if isinstance(r.get("data"), dict) else r
        items = r.get(key) or []
        out += items
        total = int(r.get("count") or 0)
        if not items or len(out) >= total or len(items) < PAGE or page > 200:
            return out
        page += 1


def _flat_categories(rows: list[dict], parent: str | None = None) -> list[dict]:
    out = []
    for c in rows or []:
        out.append({"id": c.get("id"), "name": (c.get("name") or "").strip(), "parent": c.get("parent_id") or parent})
        out += _flat_categories(c.get("subRows") or [], c.get("id"))
    return out


def run(db: Session, company_id: int, secret_token: str, import_clients: bool = True) -> dict:
    auth = fetch("POST", "/v1/auth/login", body={"secret_token": secret_token.strip()})
    token = (auth.get("data") or {}).get("access_token")
    if not token:
        raise HTTPException(422, "BILLZ не принял ключ. Проверьте, что скопировали его целиком")
    company = db.get(Company, company_id)
    rep = {"stores_created": 0, "categories_created": 0, "products_created": 0, "products_updated": 0,
           "stock_lines": 0, "clients_created": 0, "clients_updated": 0, "skipped": [], "notes": []}

    # магазины: по названию; новые — создаём
    stores = {s.name.strip().lower(): s for s in db.scalars(select(Store).where(Store.company_id == company_id))}
    shop_map: dict[str, int] = {}
    for sh in _pages(token, "/v1/shop", "shops"):
        name = (sh.get("name") or "Магазин").strip()
        st = stores.get(name.lower())
        if not st:
            st = Store(company_id=company_id, name=name, address=sh.get("address") or None)
            db.add(st)
            db.flush()
            stores[name.lower()] = st
            rep["stores_created"] += 1
        shop_map[sh.get("id")] = st.id

    # категории (дерево)
    cats = {c.name.strip().lower(): c for c in db.scalars(select(Category).where(Category.company_id == company_id))}
    cat_map: dict[str, int] = {}
    flat = _flat_categories(_pages(token, "/v2/category", "categories"))
    for c in flat:
        if not c["name"]:
            continue
        ex = cats.get(c["name"].lower())
        if not ex:
            ex = Category(company_id=company_id, name=c["name"])
            db.add(ex)
            db.flush()
            cats[c["name"].lower()] = ex
            rep["categories_created"] += 1
        cat_map[c["id"]] = ex.id
    for c in flat:  # родители — вторым проходом, когда все уже созданы
        if c["parent"] in cat_map and c["id"] in cat_map and cat_map[c["parent"]] != cat_map[c["id"]]:
            db.get(Category, cat_map[c["id"]]).parent_id = cat_map[c["parent"]]

    # товары
    by_sku = {p.sku: p for p in db.scalars(select(Product).where(Product.company_id == company_id, Product.sku.isnot(None)))}
    by_bar = {p.barcode: p for p in db.scalars(select(Product).where(Product.company_id == company_id, Product.barcode.isnot(None)))}
    for bp in _pages(token, "/v2/products", "products"):
        if bp.get("is_variative"):
            continue  # карточка-родитель вариаций, сами вариации идут отдельными товарами
        name = (bp.get("name") or "").strip()
        if not name:
            rep["skipped"].append(f"товар без названия (id {bp.get('id')})")
            continue
        sku, bar = (bp.get("sku") or "").strip() or None, (bp.get("barcode") or "").strip() or None
        p = (by_sku.get(sku) if sku else None) or (by_bar.get(bar) if bar else None)
        prices = bp.get("shop_prices") or []
        retail = max((_dec(x.get("retail_price")) for x in prices), default=Decimal(0))
        supply = max((_dec(x.get("supply_price")) for x in prices), default=Decimal(0))
        cat_ids = [c.get("id") for c in bp.get("categories") or []]
        unit = ((bp.get("measurement_unit") or {}).get("short_name") or "шт")[:20]
        if p:
            rep["products_updated"] += 1
        else:
            if sku and sku in by_sku:
                sku = None
            p = Product(company_id=company_id, name=name, sku=sku)
            db.add(p)
            rep["products_created"] += 1
        p.name, p.barcode, p.unit = name[:300], bar or p.barcode, unit
        if cat_ids and cat_ids[0] in cat_map:
            p.category_id = cat_map[cat_ids[0]]
        if retail:
            p.retail_price = retail
        if supply:
            p.cost_price = supply
        db.flush()
        if sku:
            by_sku[sku] = p
        if bar:
            by_bar[bar] = p
        for sv in bp.get("shop_measurement_values") or []:
            sid = shop_map.get(sv.get("shop_id"))
            if not sid:
                continue
            target = _dec(sv.get("active_measurement_value"))
            current = Decimal(get_level(db, p.id, sid).qty)
            if target != current:
                change_stock(db, company_id=company_id, product=p, store_id=sid, delta=target - current, reason="import",
                             ref_id=None, user_id=None, allow_negative=True)
                rep["stock_lines"] += 1

    # клиенты
    if import_clients:
        phones = {c.phone: c for c in db.scalars(select(Client).where(Client.company_id == company_id, Client.phone.isnot(None)))}
        for bc in _pages(token, "/v1/client", "clients"):
            name = " ".join(x for x in (bc.get("first_name"), bc.get("last_name")) if x).strip() or "Без имени"
            phone = next((x for x in bc.get("phone_numbers") or [] if x), None)
            phone = ("+" + phone.lstrip("+")) if phone else None
            c = phones.get(phone) if phone else None
            if c:
                rep["clients_updated"] += 1
            else:
                c = Client(company_id=company_id, name=name[:200], phone=phone, tags=["BILLZ"])
                db.add(c)
                rep["clients_created"] += 1
                if phone:
                    phones[phone] = c
            c.name = name[:200]
            g = str(bc.get("gender") or "").lower()
            c.gender = "m" if g in ("1", "male", "m") else "f" if g in ("2", "female", "f") else c.gender
            try:
                if bc.get("birth_date"):
                    c.birth_date = date.fromisoformat(str(bc["birth_date"])[:10])
            except ValueError:
                pass
    rep["notes"].append("История продаж и долги клиентов из BILLZ не переносятся: их API открыто отдаёт только справочники.")
    db.commit()
    return rep
