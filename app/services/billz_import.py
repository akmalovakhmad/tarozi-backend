"""Перенос всех данных из BILLZ (api-admin.billz.ai) в Тарози.

Импорт идёт шагами, чтобы каждый запрос укладывался в лимит времени сервера:
  catalog — магазины, категории, товары с ценами и остатками;
  staff   — сотрудники (переносятся выключенными: владелец задаёт им пароль и включает);
  people  — клиенты (с кэшбэком) и поставщики (с долгом перед ними);
  sales   — продажи, возвраты и обмены за один месяц (month=YYYY-MM): чеки, товары, оплаты, продавцы;
  debts   — долги клиентов со сроками и оплатами.
Ключ BILLZ (secret_token) используется только на время запроса и нигде не сохраняется.
Повторный запуск безопасен: записи сопоставляются по id из BILLZ (external_id), а для старых данных — по артикулу/телефону."""
import json
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (Category, Client, ClientDebt, Company, Payment, Product, Sale, SaleItem, SaleReturn, Store,
                        Supplier, User)
from app.security import hash_password

HOST = "https://api-admin.billz.ai"
PAGE = 500
STEPS = ("catalog", "staff", "people", "count", "sales", "debts")


def _http(method: str, path: str, token: str | None = None, body: dict | None = None, params: dict | None = None) -> dict:
    url = HOST + path + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", "Accept": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        if e.code == 401 or (e.code == 403 and path == "/v1/auth/login"):
            raise HTTPException(422, "BILLZ не принял ключ. Проверьте, что скопировали его целиком, и что он не отозван")
        if e.code == 403:
            raise HTTPException(422, f"У ключа BILLZ нет прав на чтение {path}. Дайте ключу доступ на чтение в BILLZ: Настройки → Интеграции")
        try:
            why = json.loads(e.read().decode() or "{}")
            why = why.get("message") or why.get("error") or (why.get("data") or {}).get("message") if isinstance(why, dict) else ""
        except Exception:
            why = ""
        raise HTTPException(502, f"BILLZ ответил ошибкой {e.code} на {path}" + (f": {str(why)[:200]}" if why else ""))
    except urllib.error.URLError:
        raise HTTPException(502, "Не удалось связаться с BILLZ. Попробуйте ещё раз через минуту")


# подменяется в тестах
fetch = _http


def _dec(v) -> Decimal:
    try:
        return Decimal(str(v)) if v not in (None, "") else Decimal(0)
    except InvalidOperation:
        return Decimal(0)


def _items(r: dict, key: str) -> tuple[list, int]:
    if isinstance(r.get("data"), dict):
        r = r["data"]
    items = r.get(key)
    if items is None and isinstance(r.get("data"), list):
        items = r["data"]
    return items or [], int(r.get("count") or 0)


def _pages(token: str, path: str, key: str, params: dict | None = None, limit: int = PAGE) -> list[dict]:
    """Все страницы списка. BILLZ может молча урезать limit (например, до 100), поэтому листаем,
    пока не наберём count, а не пока страница «полная»."""
    out, page, prev_first = [], 1, None
    while True:
        items, total = _items(fetch("GET", path, token, params={**(params or {}), "page": page, "limit": limit}), key)
        if not items:
            return out
        first = json.dumps(items[0], sort_keys=True, default=str)[:500]
        if first == prev_first:  # сервер отдал ту же страницу ещё раз — дальше листать бессмысленно
            return out
        prev_first = first
        out += items
        if (total and len(out) >= total) or (not total and len(items) < min(limit, 100)) or page >= 5000:
            return out
        page += 1


def _login(secret_token: str) -> str:
    auth = fetch("POST", "/v1/auth/login", body={"secret_token": secret_token.strip()})
    token = (auth.get("data") or {}).get("access_token")
    if not token:
        raise HTTPException(422, "BILLZ не принял ключ. Проверьте, что скопировали его целиком")
    return token


def _phone(v: str | None) -> str | None:
    d = re.sub(r"\D", "", v or "")
    return "+" + d if d else None


def _when(v, offset_min: int) -> datetime | None:
    """Дата из BILLZ → наивное UTC-время, как хранит Тарози. Без пояса считаем время местным для компании."""
    if not v:
        return None
    s = str(v).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s if "T" in s or " " in s else s + "T12:00:00")
    except ValueError:
        try:
            dt = datetime.strptime(s[:19], "%d.%m.%Y %H:%M:%S")
        except ValueError:
            return None
    if dt.tzinfo:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt - timedelta(minutes=offset_min)


def _method(name: str | None) -> str:
    n = (name or "").lower()
    if any(w in n for w in ("налич", "naqd", "cash")):
        return "cash"
    if any(w in n for w in ("долг", "qarz", "debt", "nasiya", "насия")):
        return "debt"
    if any(w in n for w in ("кэшбэк", "кешбэк", "бонус", "cashback", "bonus", "keshbek")):
        return "bonus"
    return "card"


def _report() -> dict:
    return {k: 0 for k in ("stores_created", "categories_created", "products_created", "products_updated", "stock_lines",
                           "staff_created", "clients_created", "clients_updated", "suppliers_created", "suppliers_updated",
                           "sales_created", "returns_created", "sales_skipped", "debts_created", "debts_updated")} | {"skipped": [], "notes": []}


def _by_ext(db: Session, model, company_id: int) -> dict:
    return {o.external_id: o for o in db.scalars(select(model).where(model.company_id == company_id, model.external_id.isnot(None)))}


def _shop_map(db: Session, token: str, company_id: int, rep: dict) -> dict[str, int]:
    stores = {s.name.strip().lower(): s for s in db.scalars(select(Store).where(Store.company_id == company_id))}
    ext = {s.external_id: s for s in stores.values() if s.external_id}
    out = {}
    shops = _pages(token, "/v1/shop", "shops")
    unlinked = [s for s in stores.values() if not s.external_id]
    if len(shops) == 1 and not ext and len(unlinked) == 1:
        ext[shops[0].get("id")] = unlinked[0]  # один магазин тут и один в BILLZ — это один и тот же магазин
    for sh in shops:
        name = (sh.get("name") or "Магазин").strip()
        st = ext.get(sh.get("id")) or stores.get(name.lower())
        if not st:
            st = Store(company_id=company_id, name=name[:200], address=sh.get("address") or None)
            db.add(st)
            stores[name.lower()] = st
            rep["stores_created"] += 1
        st.external_id = sh.get("id")
        db.flush()
        out[sh.get("id")] = st.id
    return out


def _flat_categories(rows: list[dict], parent: str | None = None) -> list[dict]:
    out = []
    for c in rows or []:
        out.append({"id": c.get("id"), "name": (c.get("name") or "").strip(), "parent": c.get("parent_id") or parent})
        out += _flat_categories(c.get("subRows") or [], c.get("id"))
    return out


# ---------- шаги ----------

def step_catalog(db: Session, company: Company, token: str, rep: dict, page: int = 1) -> None:
    """Каталог по страницам BILLZ (по 100 товаров за запрос), чтобы большой каталог укладывался в лимит времени.
    На первой странице заодно переносятся магазины и категории."""
    from app.models import StockLevel, StockMovement
    cid = company.id
    if page <= 1:
        _shop_map(db, token, cid, rep)
        _categories(db, token, cid, rep)
    shop_map = {s.external_id: s.id for s in db.scalars(select(Store).where(Store.company_id == cid, Store.external_id.isnot(None)))}
    cat_map = {c.external_id: c.id for c in db.scalars(select(Category).where(Category.company_id == cid, Category.external_id.isnot(None)))}

    lim = 100
    try:  # полный поиск отдаёт оптовые цены и остатки по магазинам; простой список /v2/products — запасной вариант
        r = fetch("POST", "/v2/product-search-with-filters", token,
                  body={"page": page, "limit": lim, "status": "all", "group_variations": False, "archived_list": False})
        rows, total = _items(r, "products")
        rep["catalog_source"] = "search"
        if not rows:
            raise HTTPException(404, "пусто")
    except HTTPException:
        r = fetch("GET", "/v2/products", token, params={"page": page, "limit": lim})
        rows, total = _items(r, "products")
        rep["catalog_source"] = "list"
    rep["billz_products"] = total
    rep["next_page"] = page + 1 if rows and (page * lim < total if total else len(rows) >= lim) else None

    prods = list(db.scalars(select(Product).where(Product.company_id == cid)))
    by_ext = {p.external_id: p for p in prods if p.external_id}
    by_sku = {p.sku: p for p in prods if p.sku}
    by_bar = {p.barcode: p for p in prods if p.barcode}
    todo = []
    for bp in rows:
        has_data = bp.get("shop_measurement_values") or any(_dec(x.get("retail_price")) for x in bp.get("shop_prices") or [])
        if bp.get("variations") and not has_data:
            continue  # родитель с вложенными вариациями
        if bp.get("is_variative") and not has_data and not bp.get("sku") and not bp.get("barcode"):
            continue  # пустая карточка-родитель вариаций; сами вариации приходят отдельными товарами
        name = (bp.get("name") or "").strip()
        if not name:
            rep["skipped"].append(f"товар без названия (id {bp.get('id')})")
            continue
        sku, bar = (bp.get("sku") or "").strip() or None, (bp.get("barcode") or "").strip() or None
        p = by_ext.get(bp.get("id")) or (by_sku.get(sku) if sku else None) or (by_bar.get(bar) if bar else None)
        prices = (bp.get("shop_prices") or []) + (bp.get("product_supplier_stock") or [])
        top = lambda k: _dec(bp.get(k))
        retail = max((_dec(x.get("retail_price")) for x in prices), default=Decimal(0)) or top("retail_price")
        supply = top("supply_price") or max((_dec(x.get("supply_price")) or _dec(x.get("max_supply_price")) for x in prices), default=Decimal(0))
        wholesale = max((_dec(x.get("wholesale_price")) for x in prices), default=Decimal(0)) or top("wholesale_price")
        if p:
            rep["products_updated"] += 1
        else:
            if sku and sku in by_sku:
                sku = None
            p = Product(company_id=cid, name=name[:300], sku=sku)
            db.add(p)
            rep["products_created"] += 1
        p.external_id = bp.get("id")
        p.is_active = True
        p.name, p.barcode = name[:300], bar or p.barcode
        p.unit = (((bp.get("measurement_unit") or {}).get("short_name")) or p.unit or "шт")[:20]
        cat_ids = [c.get("id") for c in bp.get("categories") or []]
        if cat_ids and cat_ids[-1] in cat_map:
            p.category_id = cat_map[cat_ids[-1]]
        if retail:
            p.retail_price = retail
        if supply:
            p.cost_price = supply
        if wholesale:
            p.wholesale_price = wholesale
        by_ext[p.external_id] = p
        if p.sku:
            by_sku[p.sku] = p
        if bar:
            by_bar[bar] = p
        levels: dict[int, Decimal] = {}
        for sv in bp.get("shop_measurement_values") or []:
            sid = shop_map.get(sv.get("shop_id"))
            if sid:
                v = next((sv[k] for k in ("active_measurement_value", "total_active_measurement_value", "total_measurement_value",
                                          "measurement_value") if sv.get(k) is not None), 0)
                levels[sid] = levels.get(sid, Decimal(0)) + _dec(v)
        if not levels:  # остатки только в разрезе поставщиков
            for sv in bp.get("product_supplier_stock") or []:
                sid = shop_map.get(sv.get("shop_id"))
                if sid:
                    levels[sid] = levels.get(sid, Decimal(0)) + _dec(sv.get("measurement_value"))
        todo.append((p, levels))
    db.flush()  # один раз на страницу: у новых товаров появятся id

    ids = [p.id for p, _ in todo]
    have = {(lv.product_id, lv.store_id): lv for lv in db.scalars(select(StockLevel).where(StockLevel.product_id.in_(ids)))} if ids else {}
    for p, levels in todo:
        if p.is_service:
            continue
        for sid, target in levels.items():
            lv = have.get((p.id, sid))
            if lv is None:
                lv = StockLevel(product_id=p.id, store_id=sid, qty=Decimal(0))
                db.add(lv)
                have[(p.id, sid)] = lv
            if target:
                rep.setdefault("stock_store_ids", set()).add(sid)
            delta = target - Decimal(lv.qty or 0)
            if delta:
                lv.qty = target
                db.add(StockMovement(company_id=cid, product_id=p.id, store_id=sid, delta=delta, reason="import", ref_id=None, user_id=None))
                rep["stock_lines"] += 1


def _categories(db: Session, token: str, cid: int, rep: dict) -> None:
    cats = {c.name.strip().lower(): c for c in db.scalars(select(Category).where(Category.company_id == cid))}
    cats_ext = {c.external_id: c for c in cats.values() if c.external_id}
    cat_map: dict[str, int] = {}
    flat = _flat_categories(_pages(token, "/v2/category", "categories"))
    for c in flat:
        if not c["name"]:
            continue
        ex = cats_ext.get(c["id"]) or cats.get(c["name"].lower())
        if not ex:
            ex = Category(company_id=cid, name=c["name"][:200])
            db.add(ex)
            cats[c["name"].lower()] = ex
            rep["categories_created"] += 1
        ex.external_id = c["id"]
        db.flush()
        cat_map[c["id"]] = ex.id
    for c in flat:
        if c["parent"] in cat_map and c["id"] in cat_map and cat_map[c["parent"]] != cat_map[c["id"]]:
            db.get(Category, cat_map[c["id"]]).parent_id = cat_map[c["parent"]]


def step_staff(db: Session, company: Company, token: str, rep: dict) -> None:
    cid = company.id
    shop_ext = {s.external_id: s.id for s in db.scalars(select(Store).where(Store.company_id == cid, Store.external_id.isnot(None)))}
    users = _by_ext(db, User, cid)
    for bu in _pages(token, "/v1/user", "users", {"type": 1}):
        if bu.get("deleted_at"):
            continue
        name = " ".join(x for x in (bu.get("first_name"), bu.get("last_name")) if x).strip() or "Сотрудник"
        u = users.get(bu.get("id"))
        if not u:
            u = User(company_id=cid, name=name[:200], login=f"billz-{company.id}-{secrets.token_hex(3)}",
                     password_hash=hash_password(secrets.token_urlsafe(24)), is_owner=False, is_active=False,
                     external_id=bu.get("id"), store_ids=[])
            db.add(u)
            users[u.external_id] = u
            rep["staff_created"] += 1
        u.name = name[:200]
        u.store_ids = [shop_ext[s.get("shop_id")] for s in bu.get("shops") or [] if s.get("shop_id") in shop_ext]
    db.flush()
    if rep["staff_created"]:
        rep["notes"].append("Сотрудники перенесены выключенными: задайте каждому логин и пароль в разделе «Сотрудники» и включите.")


def step_people(db: Session, company: Company, token: str, rep: dict) -> None:
    cid = company.id
    clients = list(db.scalars(select(Client).where(Client.company_id == cid)))
    by_ext = {c.external_id: c for c in clients if c.external_id}
    by_phone = {c.phone: c for c in clients if c.phone}
    for bc in _pages(token, "/v1/client", "clients"):
        name = " ".join(x for x in (bc.get("first_name"), bc.get("last_name")) if x).strip() or "Без имени"
        phones = [_phone(x) for x in bc.get("phone_numbers") or [] if x]
        phone = phones[0] if phones else None
        c = by_ext.get(bc.get("id")) or (by_phone.get(phone) if phone else None)
        if c:
            rep["clients_updated"] += 1
        else:
            c = Client(company_id=cid, name=name[:200], phone=phone, tags=["BILLZ"])
            db.add(c)
            rep["clients_created"] += 1
            if phone:
                by_phone[phone] = c
        c.external_id = bc.get("id")
        by_ext[c.external_id] = c
        c.name = name[:200]
        c.phone = phone or c.phone
        if len(phones) > 1:
            extra = "Другие телефоны: " + ", ".join(phones[1:])
            if extra not in (c.note or ""):
                c.note = ((c.note + "\n") if c.note else "") + extra
        c.bonus_balance = _dec(bc.get("balance"))
        g = str(bc.get("gender") or "").lower()
        c.gender = "m" if g in ("1", "male", "m") else "f" if g in ("2", "female", "f") else c.gender
        try:
            if bc.get("birth_date"):
                c.birth_date = date.fromisoformat(str(bc["birth_date"])[:10])
        except ValueError:
            pass
        made = _when(bc.get("created_at"), company.utc_offset_minutes)
        if made:
            c.created_at = made
    db.flush()

    sups = list(db.scalars(select(Supplier).where(Supplier.company_id == cid)))
    s_ext = {s.external_id: s for s in sups if s.external_id}
    s_name = {s.name.strip().lower(): s for s in sups}
    for bs in _pages(token, "/v1/supplier", "suppliers"):
        name = (bs.get("name") or "").strip()
        if not name:
            continue
        s = s_ext.get(bs.get("id")) or s_name.get(name.lower())
        if s:
            rep["suppliers_updated"] += 1
        else:
            s = Supplier(company_id=cid, name=name[:200])
            db.add(s)
            s_name[name.lower()] = s
            rep["suppliers_created"] += 1
        s.external_id = bs.get("id")
        phones = [_phone(x) for x in bs.get("phone_numbers") or [] if x]
        s.phone = phones[0] if phones else s.phone
        s.opening_balance = _dec(bs.get("debt_value"))  # наш долг поставщику на момент переноса
    db.flush()


def _safe_pages(token, path, key, params, rep, shop_ids: list[str] | None = None) -> list[dict]:
    """Вспомогательные отчёты. На 400 пробуем другие варианты запроса (меньше страница, явный список магазинов);
    если BILLZ так и не отдаёт отчёт — работаем дальше по карточкам чеков, это медленнее, но данные те же."""
    tries = [(params, PAGE), (params, 100)]
    if shop_ids:
        tries += [({**params, "shop_ids": ",".join(shop_ids)}, 100), ({**params, "shop_ids": ",".join(shop_ids)}, 10)]
    last = None
    for prm, lim in tries:
        try:
            return _pages(token, path, key, prm, lim)
        except HTTPException as e:
            last = e
            if "400" not in str(e.detail):
                break
    rep.setdefault("warnings", []).append(f"отчёт {path} недоступен ({last.detail}); оплаты и товары взяты из карточек чеков")
    return []


def _order_search(token: str, rng: dict, rep: dict) -> list[dict]:
    """Список чеков за период: GET /v3/order-search, чеки сгруппированы по дням."""
    out, page = [], 1
    while True:
        r = fetch("GET", "/v3/order-search", token, params={**rng, "page": page, "limit": 100})
        if isinstance(r.get("data"), dict):
            r = r["data"]
        if page == 1:
            rep["probe"] = {"keys": sorted(r.keys())[:12], "count": r.get("count")}
        got = []
        for day in r.get("orders_sorted_by_date_list") or []:
            got += day.get("orders") or []
        got += r.get("orders") or []
        out += got
        total = int(r.get("count") or 0)
        if not got or (total and len(out) >= total) or page >= 500:
            return out
        page += 1


def _detail(token: str, oid: str) -> dict:
    r = fetch("GET", f"/v2/order/{oid}", token)
    return r["data"] if isinstance(r.get("data"), dict) and "order_detail" in r["data"] else r


def step_sales(db: Session, company: Company, token: str, rep: dict, month: str, budget_s: float = 200) -> None:
    """Чеки одного месяца. Список — /v3/order-search, товары — отчёт покупок, оплаты — отчёт транзакций;
    чего нет в отчётах, берём из карточки чека /v2/order/{id}. Если время запроса на исходе — отдаём incomplete,
    и интерфейс повторяет тот же месяц (уже перенесённые чеки пропускаются)."""
    import time
    t0 = time.monotonic()
    cid = company.id
    try:
        start = date.fromisoformat(month + "-01")
    except ValueError:
        raise HTTPException(422, "Месяц укажите в виде ГГГГ-ММ")
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    rng = {"start_date": start.isoformat(), "end_date": end.isoformat()}
    orders = _order_search(token, rng, rep)
    rep["month"], rep["month_transactions"], rep["incomplete"] = month, len(orders), False
    if not orders:
        return

    stores_all = list(db.scalars(select(Store).where(Store.company_id == cid)))
    stores = {s.external_id: s.id for s in stores_all if s.external_id}
    stores_by_name = {s.name.strip().lower(): s.id for s in stores_all}
    default_store = next(iter(stores.values()), None) or (stores_all[0].id if stores_all else None)
    users = {u.external_id: u.id for u in db.scalars(select(User).where(User.company_id == cid, User.external_id.isnot(None)))}
    owner = db.scalar(select(User.id).where(User.company_id == cid, User.is_owner.is_(True)).order_by(User.id))
    clients = {c.external_id: c.id for c in db.scalars(select(Client).where(Client.company_id == cid, Client.external_id.isnot(None)))}
    prods = list(db.scalars(select(Product).where(Product.company_id == cid)))
    p_ext = {p.external_id: p for p in prods if p.external_id}
    p_sku = {p.sku: p for p in prods if p.sku}
    p_bar = {p.barcode: p for p in prods if p.barcode}
    ids = [o.get("id") for o in orders if o.get("id")]
    parent_ids = [o.get("parent_id") for o in orders if o.get("parent_id")]
    known = {s.external_id: s for s in db.scalars(select(Sale).where(Sale.company_id == cid, Sale.external_id.in_(ids + parent_ids)))} if ids else {}
    done_returns = set(db.scalars(select(SaleReturn.external_id).where(SaleReturn.company_id == cid, SaleReturn.external_id.in_(ids)))) if ids else set()

    todo = [o for o in orders if o.get("id") and o["id"] not in known and o["id"] not in done_returns]
    todo.sort(key=lambda o: str(o.get("sold_at") or o.get("finished_at") or o.get("created_at") or ""))  # исходный чек раньше возврата
    rep["sales_skipped"] += len(orders) - len(todo)
    if not todo:
        return
    lines: dict[str, list] = {}
    shop_ids = list(stores.keys())
    for ln in _safe_pages(token, "/v1/customer-purchases-table", "purchases", {**rng, "with_customers": "false"}, rep, shop_ids):
        lines.setdefault(ln.get("order_id"), []).append(ln)
    trx = {r.get("order_id"): r for r in _safe_pages(token, "/v1/transaction-report-table", "rows", rng, rep, shop_ids)}

    def product_for(pid, name, sku=None, bar=None, unit=None) -> Product:
        p = p_ext.get(pid) or (p_sku.get(sku) if sku else None) or (p_bar.get(bar) if bar else None)
        if not p:  # товар удалён в BILLZ — архивная карточка, чтобы история не потерялась
            p = Product(company_id=cid, name=(name or "Товар из BILLZ")[:300], external_id=pid, unit=(unit or "шт")[:20], is_active=False)
            db.add(p)
            db.flush()
            if pid:
                p_ext[pid] = p
        return p

    q2 = Decimal("0.01")
    for o in todo:
        if time.monotonic() - t0 > budget_s:
            rep["incomplete"] = True
            break
        oid = o["id"]
        det = o.get("order_detail") or {}
        kind = (o.get("order_type") or "SALE").upper()
        items, pays = [], []
        for ln in lines.get(oid) or []:
            qty = abs(_dec(ln.get("sold_measurement_value")) or _dec(ln.get("returned_measurement_value")))
            if not qty:
                continue
            gross, net = abs(_dec(ln.get("gross_sales"))), abs(_dec(ln.get("net_sales")))
            items.append(dict(p=product_for(ln.get("product_id"), ln.get("product_name"), ln.get("product_sku"), ln.get("product_barcode"),
                                            ln.get("product_measurement_unit_short_name")),
                              name=ln.get("product_name"), qty=qty, gross=gross, net=net or gross, cost=abs(_dec(ln.get("net_sold_supply_sum")))))
        t = trx.get(oid)
        if t:
            pays = [(_method(pm.get("payment_type_name")), abs(_dec(pm.get("sum")))) for pm in t.get("payments") or []]
        if not items or not pays:
            try:
                full = _detail(token, oid)
            except HTTPException:
                full = {}
            fd = full.get("order_detail") or {}
            det = {**det, **{k: v for k, v in fd.items() if v not in (None, "", [])}}
            if not items:
                for it in fd.get("order_items") or []:
                    qty = abs(_dec(it.get("measurement_value")))
                    if not qty:
                        continue
                    pr = it.get("product") or {}
                    total = abs(_dec(it.get("total_price")))
                    gross = abs(_dec(it.get("retail_price"))) * qty or total + abs(_dec(it.get("discount_amount")))
                    items.append(dict(p=product_for(pr.get("id") or it.get("product_id"), pr.get("name") or it.get("name"), pr.get("sku") or it.get("sku"),
                                                    pr.get("barcode") or it.get("barcode"), (pr.get("measurement_unit") or {}).get("short_name")),
                                      name=pr.get("name") or it.get("name"), qty=qty, gross=max(gross, total), net=total,
                                      cost=abs(_dec(it.get("supply_price"))) * qty))
            if not pays:
                pays = [(_method((pm.get("company_payment_type") or {}).get("name")), abs(_dec(pm.get("paid_amount"))) - abs(_dec(pm.get("returned_amount"))))
                        for pm in fd.get("order_payments") or []]
                if _dec(full.get("debt")) > 0 and not any(m == "debt" for m, _ in pays):
                    pays.append(("debt", _dec(full.get("debt"))))
        when = (_when(o.get("sold_at") or o.get("finished_at") or o.get("created_at_utc"), 0) if (o.get("sold_at") or o.get("finished_at") or o.get("created_at_utc"))
                else _when(o.get("created_at") or (t or {}).get("date"), company.utc_offset_minutes)) or datetime.combine(start, datetime.min.time())
        cashier = users.get((det.get("user") or {}).get("id") or det.get("user_id"))
        sellers = [users[x] for x in (t or {}).get("seller_ids") or [] if x in users]
        seller = (sellers[0] if sellers else None) or cashier or owner
        shop = det.get("shop") or {}
        store_id = stores.get(shop.get("id") or det.get("shop_id")) or stores.get((t or {}).get("shop_id")) \
            or stores_by_name.get((shop.get("name") or "").strip().lower()) or default_store
        cust = o.get("customer_id") or (det.get("customer") or {}).get("id") or (t or {}).get("customer_id")
        total = sum((a for _, a in pays if a > 0), Decimal(0)) or sum((i["net"] for i in items), Decimal(0)) or abs(_dec(det.get("total_price")))
        sub = max(sum((i["gross"] for i in items), Decimal(0)), total)

        parent = known.get(o.get("parent_id"))
        if kind == "RETURN" and parent is not None:
            # возврат по чеку, который уже перенесён: отмечаем возврат на исходном чеке
            ret_items = []
            for i in items:
                si = next((x for x in parent.items if x.product_id == i["p"].id and Decimal(x.qty) > Decimal(x.returned_qty)), None)
                if si:
                    si.returned_qty = min(Decimal(si.qty), Decimal(si.returned_qty) + i["qty"])
                    ret_items.append({"sale_item_id": si.id, "qty": float(i["qty"]), "amount": float(i["net"])})
            parent.returned_total = Decimal(parent.returned_total) + total
            db.add(SaleReturn(company_id=cid, sale_id=parent.id, store_id=store_id or parent.store_id, user_id=cashier or seller,
                              amount=total, refund_method=pays[0][0] if pays else "cash", reason="Возврат из BILLZ",
                              created_at=when, items=ret_items, external_id=oid))
            known[oid] = parent
            rep["returns_created"] += 1
            continue

        num_raw = str(o.get("order_number") or "")
        number = int(num_raw) if num_raw.isdigit() and len(num_raw) < 10 else None
        if number is None:
            company.receipt_counter += 1
            number = company.receipt_counter
        company.receipt_counter = max(company.receipt_counter, number)
        sale = Sale(company_id=cid, number=number, store_id=store_id, seller_id=seller, created_by=cashier or seller,
                    client_id=clients.get(cust), external_id=oid, status="return" if kind == "RETURN" else "completed",
                    comment=(det.get("comment") or None), created_at=when, subtotal=sub, total=total, discount=max(sub - total, Decimal(0)))
        for i in items:
            sale.items.append(SaleItem(product_id=i["p"].id, name=(i["name"] or i["p"].name)[:300], is_service=i["p"].is_service,
                                       qty=i["qty"], price=(i["gross"] / i["qty"]).quantize(q2), cost_price=(i["cost"] / i["qty"]).quantize(q2),
                                       discount=max(i["gross"] - i["net"], Decimal(0)), total=i["net"]))
        for m, a in pays:
            if a > 0:
                sale.payments.append(Payment(method=m, amount=a))
        db.add(sale)
        db.flush()
        known[oid] = sale
        if kind == "RETURN":
            db.add(SaleReturn(company_id=cid, sale_id=sale.id, store_id=sale.store_id, user_id=cashier or seller, amount=total,
                              refund_method=pays[0][0] if pays else "cash", reason="Возврат из BILLZ", created_at=when,
                              items=[{"sale_item_id": x.id, "qty": float(x.qty), "amount": float(x.total)} for x in sale.items]))
            rep["returns_created"] += 1
        else:
            rep["sales_created"] += 1
        if (rep["sales_created"] + rep["returns_created"]) % 200 == 0:
            db.commit()  # промежуточное сохранение: при обрыве повтор продолжит с этого места


def step_debts(db: Session, company: Company, token: str, rep: dict) -> None:
    cid = company.id
    clients = {c.external_id: c for c in db.scalars(select(Client).where(Client.company_id == cid, Client.external_id.isnot(None)))}
    stores = {s.external_id: s.id for s in db.scalars(select(Store).where(Store.company_id == cid, Store.external_id.isnot(None)))}
    sales = {s.external_id: s.id for s in db.scalars(select(Sale).where(Sale.company_id == cid, Sale.external_id.isnot(None)))}
    debts = _by_ext(db, ClientDebt, cid)
    touched = set()
    for bd in _pages(token, "/v1/debt", "data"):
        if bd.get("deleted_at"):
            continue
        cust = bd.get("customer") or {}
        c = clients.get(cust.get("id"))
        if not c:
            name = (cust.get("name") or " ".join(x for x in (cust.get("first_name"), cust.get("last_name")) if x)).strip() or "Клиент из BILLZ"
            phones = [_phone(x) for x in bd.get("contact_phones") or [] if x]
            c = Client(company_id=cid, name=name[:200], phone=phones[0] if phones else None, tags=["BILLZ"], external_id=cust.get("id"))
            db.add(c)
            db.flush()
            clients[c.external_id] = c
            rep["clients_created"] += 1
        d = debts.get(bd.get("id"))
        if d:
            rep["debts_updated"] += 1
        else:
            d = ClientDebt(company_id=cid, client_id=c.id, external_id=bd.get("id"), amount=Decimal(0))
            db.add(d)
            debts[d.external_id] = d
            rep["debts_created"] += 1
        d.client_id = c.id
        d.amount, d.paid = _dec(bd.get("amount")), min(_dec(bd.get("paid_amount")), _dec(bd.get("amount")))
        d.sale_id = sales.get(bd.get("order_id"))
        d.store_id = stores.get((bd.get("shop") or {}).get("id"))
        rd = _when(bd.get("repayment_date"), 0)
        d.due_date = rd.date() if rd else None
        d.note = (f"Чек BILLZ №{bd.get('order_number')}" if bd.get("order_number") else None) or (bd.get("comment") or None)
        made = _when(bd.get("created_at"), company.utc_offset_minutes)
        if made:
            d.created_at = made
        touched.add(c.id)
    db.flush()
    for client_id in touched:  # долг клиента = сумма непогашенных остатков его долгов
        rows = db.scalars(select(ClientDebt).where(ClientDebt.client_id == client_id)).all()
        db.get(Client, client_id).debt_balance = sum((Decimal(x.amount) - Decimal(x.paid) for x in rows), Decimal(0))


def run(db: Session, company_id: int, secret_token: str, step: str = "all", month: str | None = None,
        import_clients: bool = True, page: int = 1) -> dict:
    if step not in STEPS + ("all",):
        raise HTTPException(422, "Неизвестный шаг переноса")
    token = _login(secret_token)
    company = db.get(Company, company_id)
    rep = _report()
    todo = ("catalog", "staff", "people", "debts") if step == "all" else (step,)
    for s in todo:
        if s == "people" and not import_clients:
            continue
        if s == "count":  # сколько чеков за месяц — чтобы найти, с какого месяца начинается история
            m = date.fromisoformat((month or date.today().strftime("%Y-%m")) + "-01")
            end = (m.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
            r = fetch("GET", "/v3/order-search", token, params={"start_date": m.isoformat(), "end_date": end.isoformat(), "page": 1, "limit": 1})
            r = r["data"] if isinstance(r.get("data"), dict) else r
            n = int(r.get("count") or 0) or sum(len(d.get("orders") or []) for d in r.get("orders_sorted_by_date_list") or [])
            rep["month"], rep["month_transactions"] = m.strftime("%Y-%m"), n
        elif s == "catalog":
            step_catalog(db, company, token, rep, page)
            if step == "all":
                while rep.get("next_page"):
                    step_catalog(db, company, token, rep, rep["next_page"])
        elif s == "sales":
            step_sales(db, company, token, rep, month or date.today().strftime("%Y-%m"))
        else:
            globals()["step_" + s](db, company, token, rep)
    if rep.get("stock_store_ids"):
        rep["stock_stores"] = sorted(st.name for st in db.scalars(select(Store).where(Store.id.in_(rep.pop("stock_store_ids")))))
    db.commit()
    return rep
