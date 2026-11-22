from datetime import date, timedelta

from tests.conftest import register
from tests.test_flow import setup_catalog


def test_discounts_wholesale_seller_and_split_payment(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)
    c.patch(f"/api/products/{a}", json={"wholesale_price": 18}, headers=h)
    roles = {r["name"]: r["id"] for r in c.get("/api/roles", headers=h).json()}
    seller = c.post("/api/users", json={"name": "Нигора", "login": "nigora", "password": "kassa12345",
                                        "role_id": roles["Кассир"]}, headers=h).json()
    assert {s["name"] for s in c.get("/api/sales/sellers", headers=h).json()} == {"Дилшод", "Нигора"}

    # опт: 2 × 18 = 36, ручная скидка 10% → 32.40; оплата частями
    body = {"store_id": store, "items": [{"product_id": a, "qty": 2}], "wholesale": True, "manual_discount_percent": 10,
            "seller_id": seller["id"], "comment": "Постоянный покупатель",
            "payments": [{"method": "cash", "amount": 20}, {"method": "card", "amount": 12.4}]}
    q = c.post("/api/sales/quote", json=body, headers=h).json()
    assert q["subtotal"] == 36 and q["total"] == 32.4
    s = c.post("/api/sales", json=body, headers=h)
    assert s.status_code == 201, s.text
    s = s.json()
    assert s["seller_id"] == seller["id"] and s["comment"] == "Постоянный покупатель"
    assert {p["method"]: p["amount"] for p in s["payments"]} == {"cash": 20, "card": 12.4}

    # скидка суммой
    q = c.post("/api/sales/quote", json={"store_id": store, "items": [{"product_id": b, "qty": 1}], "manual_discount_amount": 4}, headers=h).json()
    assert q["total"] == 15

    # кассир без права на ручную скидку
    tok = c.post("/api/auth/login", data={"username": "nigora", "password": "kassa12345"}).json()["access_token"]
    k = {"Authorization": f"Bearer {tok}"}
    r = c.post("/api/sales/quote", json={"store_id": store, "items": [{"product_id": b, "qty": 1}], "manual_discount_percent": 5}, headers=k)
    assert r.status_code == 403


def test_exchange(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)
    sale = c.post("/api/sales", json={"store_id": store, "items": [{"product_id": a, "qty": 2}],
                                     "payments": [{"method": "cash", "amount": 44}]}, headers=h).json()
    line = sale["items"][0]
    # меняем 1 помаду (22) на шампунь (19): разницу 3 возвращаем
    r = c.post(f"/api/sales/{sale['id']}/exchange", json={"return_items": [{"sale_item_id": line["id"], "qty": 1}],
                                                          "items": [{"product_id": b, "qty": 1}]}, headers=h)
    assert r.status_code == 201, r.text
    ex = r.json()
    assert ex["returned"] == 22 and ex["refund"] == 3 and ex["sale"]["exchange_of_id"] == sale["id"]
    assert ex["sale"]["payments"] == [{"method": "exchange", "amount": 19}]
    # меняем ещё 1 помаду на 2 шампуня (38): доплата 16 картой
    r = c.post(f"/api/sales/{sale['id']}/exchange", json={"return_items": [{"sale_item_id": line["id"], "qty": 1}],
                                                          "items": [{"product_id": b, "qty": 2}],
                                                          "payments": [{"method": "card", "amount": 16}]}, headers=h)
    assert r.status_code == 201, r.text
    assert c.get(f"/api/products/{a}", headers=h).json()["stock_total"] == 10
    assert c.get(f"/api/products/{b}", headers=h).json()["stock_total"] == 0
    d = c.get("/api/reports/dashboard", headers=h).json()
    assert d["transactions"]["exchanges_count"] == 2 and d["transactions"]["returns_count"] == 0
    assert d["revenue"]["net"] == 44 - 44 + 19 + 38  # исходная продажа полностью обменяна


def test_debts_with_due_dates(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)
    cl = c.post("/api/clients", json={"name": "Азиз", "phone": "+998901112233", "gender": "m"}, headers=h).json()["id"]
    past = str(date.today() - timedelta(days=3))
    s1 = c.post("/api/sales", json={"store_id": store, "client_id": cl, "items": [{"product_id": a, "qty": 1}], "debt_due_date": past,
                                   "payments": [{"method": "debt", "amount": 22}]}, headers=h).json()
    c.post("/api/sales", json={"store_id": store, "client_id": cl, "items": [{"product_id": b, "qty": 1}],
                               "payments": [{"method": "cash", "amount": 9}, {"method": "debt", "amount": 10}]}, headers=h)
    d = c.get("/api/debts", headers=h).json()
    assert d["summary"]["left"] == 32 and d["summary"]["overdue"] == 1 and d["summary"]["unpaid"] == 1
    overdue = next(x for x in d["items"] if x["status"] == "overdue")
    assert overdue["sale_number"] == s1["number"]

    # частичная оплата идёт в первую очередь на просроченный
    c.post(f"/api/clients/{cl}/debt-payments", json={"amount": 12, "method": "cash"}, headers=h)
    d = c.get("/api/debts", headers=h).json()
    assert d["summary"]["left"] == 20
    od = next(x for x in d["items"] if x["status"] == "overdue")
    assert od["paid"] == 12 and od["left"] == 10  # частично оплачен, но срок прошёл — остаётся просроченным

    # возврат товара в счёт долга — системное погашение долга этой продажи
    r = c.post(f"/api/sales/{s1['id']}/returns", json={"items": [{"sale_item_id": s1["items"][0]["id"], "qty": 1}],
                                                       "refund_method": "debt"}, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["refund_method"] == "debt+cash"  # долг 20, возврат 22: 20 в долг, 2 наличными
    d = c.get("/api/debts?status=paid", headers=h).json()
    assert d["total"] == 2 and d["summary"]["left"] == 0

    # массовое погашение: новый долг и гасим его списком
    c.post("/api/sales", json={"store_id": store, "client_id": cl, "items": [{"product_id": a, "qty": 1}],
                               "payments": [{"method": "debt", "amount": 22}]}, headers=h)
    open_ids = [x["id"] for x in c.get("/api/debts?status=unpaid", headers=h).json()["items"]]
    assert c.post("/api/debts/pay", json={"debt_ids": open_ids, "method": "card"}, headers=h).json()["paid"] == 22
    assert c.get(f"/api/clients/{cl}", headers=h).json()["debt_balance"] == 0
    pays = c.get("/api/debts/payments", headers=h).json()
    assert {p["method"] for p in pays["items"]} == {"cash", "return", "card"} and pays["items"][0]["client_name"] == "Азиз"

    st = c.get(f"/api/clients/{cl}/statement", headers=h).json()
    assert st["debit"] == 54 and st["credit"] == 54 and st["closing"] == 0 and len(st["rows"]) == 6

    one = c.get(f"/api/clients/{cl}", headers=h).json()
    assert one["gender"] == "m" and one["purchases_count"] == 3 and one["purchases_total"] == 41
    stats = c.get("/api/clients/stats", headers=h).json()
    assert stats["total"] == 1 and stats["new_week"] == 1


def test_supplier_debt_payments_and_returns(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)  # приход a: 10 × 11 без поставщика
    sup = c.post("/api/suppliers", json={"name": "Morgans"}, headers=h).json()["id"]
    doc = c.post("/api/stock/supplier_order", json={"store_id": store, "supplier_id": sup,
                                                    "items": [{"product_id": a, "qty": 5, "price": 10}, {"product_id": b, "qty": 4, "price": 8}]}, headers=h).json()
    assert doc["total"] == 82
    c.post(f"/api/stock/supplier_order/{doc['id']}/complete", headers=h)
    c.post(f"/api/suppliers/{sup}/payments", json={"amount": 50, "method": "transfer", "document_id": doc["id"]}, headers=h)
    ret = c.post("/api/stock/supplier_return", json={"store_id": store, "supplier_id": sup, "items": [{"product_id": b, "qty": 1, "price": 8}]}, headers=h).json()
    c.post(f"/api/stock/supplier_return/{ret['id']}/complete", headers=h)
    s = next(x for x in c.get("/api/suppliers", headers=h).json() if x["id"] == sup)
    assert s["orders_total"] == 82 and s["paid_total"] == 50 and s["returns_total"] == 8 and s["debt"] == 24 and s["items_count"] == 9
    orders = c.get(f"/api/stock/supplier_order?supplier_id={sup}", headers=h).json()
    assert orders[0]["paid"] == 50
    assert c.get(f"/api/products/{b}", headers=h).json()["stock_total"] == 6


def test_billz_import(client, monkeypatch):
    from app.services import billz_import

    def fake(method, path, token=None, body=None, params=None):
        if path == "/v1/auth/login":
            return {"code": 200, "data": {"access_token": "t"}} if body["secret_token"] == "good-token-1234567890" else {"code": 401}
        if path == "/v1/shop":
            return {"count": 1, "shops": [{"id": "s1", "name": "Store Blitz", "address": "Ташкент"}]}
        if path == "/v2/category":
            return {"count": 1, "categories": [{"id": "c1", "name": "Укладка", "parent_id": "", "subRows": [{"id": "c2", "name": "Помады", "parent_id": "c1", "subRows": []}]}]}
        if path == "/v2/products":
            return {"count": 2, "products": [
                {"id": "p1", "name": "Pomade Red", "sku": "M008", "barcode": "5012", "is_variative": False, "categories": [{"id": "c2"}],
                 "measurement_unit": {"short_name": "шт"}, "shop_prices": [{"shop_id": "s1", "retail_price": 100, "supply_price": 36}],
                 "shop_measurement_values": [{"shop_id": "s1", "active_measurement_value": 7}]},
                {"id": "p0", "name": "Parent", "is_variative": True}]}
        if path == "/v1/user":
            return {"count": 1, "users": [{"id": "u1", "first_name": "Нодира", "last_name": "Ахмедова", "shops": [{"shop_id": "s1"}]}]}
        if path == "/v1/client":
            return {"count": 1, "clients": [{"id": "k1", "first_name": "Азиз", "last_name": "Каримов", "phone_numbers": ["998901112233"],
                                             "gender": "male", "birth_date": "1990-05-14", "balance": 15}]}
        if path == "/v1/supplier":
            return {"count": 1, "suppliers": [{"id": "sp1", "name": "ООО Стиль", "debt_value": 500, "phone_numbers": ["998711234567"]}]}
        if path == "/v3/order-search":
            if params["start_date"] != "2026-10-01":
                return {"count": 0, "orders_sorted_by_date_list": []}
            return {"count": 3, "orders_sorted_by_date_list": [
                {"date": "2026-10-05", "orders": [{"id": "o1", "order_number": "1042", "order_type": "SALE", "customer_id": "k1",
                                                   "sold_at": "2026-10-05T09:30:00Z", "order_detail": {"user": {"id": "u1"}, "shop": {"id": "s1"}}}]},
                {"date": "2026-10-06", "orders": [{"id": "o2", "parent_id": "o1", "order_number": "1043", "order_type": "RETURN",
                                                   "sold_at": "2026-10-06T05:00:00Z", "order_detail": {"shop": {"id": "s1"}}},
                                                  {"id": "o3", "order_number": "1044", "order_type": "SALE",
                                                   "sold_at": "2026-10-06T06:00:00Z", "order_detail": {"shop": {"id": "s1"}}}]}]}
        if path.startswith("/v2/order/"):
            oid = path.rsplit("/", 1)[1]
            if oid == "o3":
                return {"id": "o3", "debt": 0, "order_detail": {"order_items": [
                    {"product": {"id": "p1", "name": "Pomade Red"}, "measurement_value": 1, "retail_price": 100, "total_price": 100, "supply_price": 36}],
                    "order_payments": [{"company_payment_type": {"name": "Uzcard"}, "paid_amount": 100, "returned_amount": 0}]}}
            return {"id": oid, "order_detail": {"order_payments": [{"company_payment_type": {"name": "Наличные"}, "paid_amount": 90}]}}
        if path == "/v1/transaction-report-table":
            if params["start_date"] != "2026-10-01":
                return {"rows": []}
            return {"count": 2, "rows": [
                {"order_id": "o1", "date": "2026-10-05 14:30:00", "shop_id": "s1", "customer_id": "k1", "seller_ids": ["u1"], "cashier_id": "u1",
                 "order_type": "SALE", "total_price": 200, "gross_sales": 180,
                 "payments": [{"payment_type_name": "Наличные", "sum": 100}, {"payment_type_name": "Долг", "sum": 80}]},
                {"order_id": "o2", "date": "2026-10-06 10:00:00", "shop_id": "s1", "customer_id": "k1", "seller_ids": ["u1"],
                 "order_type": "RETURN", "total_price": 90, "gross_sales": 90, "payments": [{"payment_type_name": "Наличные", "sum": 90}]}]}
        if path == "/v1/customer-purchases-table":
            return {"count": 3, "purchases": [
                {"order_id": "o1", "order_number": "1042", "product_id": "p1", "product_name": "Pomade Red", "sold_measurement_value": 2,
                 "gross_sales": 200, "net_sales": 180, "net_sold_supply_sum": 72},
                {"order_id": "o2", "order_number": "1043", "product_id": "p1", "product_name": "Pomade Red", "returned_measurement_value": 1,
                 "gross_sales": -90, "net_sales": -90, "net_sold_supply_sum": -36},
                {"order_id": "o1", "order_number": "1042", "product_id": "gone", "product_name": "Старый воск", "sold_measurement_value": 0}]}
        if path == "/v1/debt":
            return {"count": 1, "data": [{"id": "d1", "order_id": "o1", "order_number": "1042", "amount": 80, "paid_amount": 30,
                                          "repayment_date": "2026-12-01", "customer": {"id": "k1"}, "shop": {"id": "s1"}}]}
        return {}
    monkeypatch.setattr(billz_import, "fetch", fake)
    h = register(client)
    tok = "good-token-1234567890"
    bad = client.post("/api/import/billz", json={"secret_token": "wrong-token-1234567890"}, headers=h)
    assert bad.status_code == 422
    for step in ("catalog", "staff", "people"):
        r = client.post("/api/import/billz", json={"secret_token": tok, "step": step}, headers=h)
        assert r.status_code == 200, r.text
    r = client.post("/api/import/billz", json={"secret_token": tok, "step": "sales", "month": "2026-10"}, headers=h).json()
    assert r["sales_created"] == 2 and r["returns_created"] == 1 and r["month_transactions"] == 3, r
    empty = client.post("/api/import/billz", json={"secret_token": tok, "step": "sales", "month": "2026-09"}, headers=h).json()
    assert empty["month_transactions"] == 0
    d = client.post("/api/import/billz", json={"secret_token": tok, "step": "debts"}, headers=h).json()
    assert d["debts_created"] == 1

    p = client.get("/api/products?q=M008", headers=h).json()["items"][0]
    assert p["retail_price"] == 100 and p["cost_price"] == 36 and p["stock_total"] == 7
    c = client.get("/api/clients?q=Азиз", headers=h).json()["items"][0]
    assert c["phone"] == "+998901112233" and c["gender"] == "m" and c["bonus_balance"] == 15 and c["debt_balance"] == 50
    sup = [s for s in client.get("/api/suppliers", headers=h).json() if s["name"] == "ООО Стиль"][0]
    assert sup["debt"] == 500
    staff = [u for u in client.get("/api/users", headers=h).json() if u["name"] == "Нодира Ахмедова"][0]
    assert staff["is_active"] is False
    sales = client.get("/api/sales?status=completed&date_from=2026-10-01&date_to=2026-10-31", headers=h).json()
    items = sales["items"] if isinstance(sales, dict) else sales
    s = [x for x in items if x["number"] == 1042][0]
    assert s["total"] == 180 and s["discount"] == 20 and {pm["method"] for pm in s["payments"]} == {"cash", "debt"}

    # повторный перенос ничего не дублирует
    client.post("/api/import/billz", json={"secret_token": tok, "step": "catalog"}, headers=h)
    again = client.post("/api/import/billz", json={"secret_token": tok, "step": "sales", "month": "2026-10"}, headers=h).json()
    assert again["sales_created"] == 0 and again["sales_skipped"] == 3
    s3 = [x for x in items if x["number"] == 1044][0]
    assert s3["total"] == 100 and s3["payments"][0]["method"] == "card" and s3["items"][0]["qty"] == 1
    assert s["items"][0]["returned_qty"] == 1
    d2 = client.post("/api/import/billz", json={"secret_token": tok, "step": "debts"}, headers=h).json()
    assert d2["debts_created"] == 0 and d2["debts_updated"] == 1


def test_billz_report_400_fallback(monkeypatch):
    from fastapi import HTTPException
    from app.services import billz_import
    seen = []

    def fake(method, path, token=None, body=None, params=None):
        seen.append(dict(params))
        if "shop_ids" not in params:
            raise HTTPException(502, f"BILLZ ответил ошибкой 400 на {path}")
        return {"count": 1, "rows": [{"order_id": "o1"}]}
    monkeypatch.setattr(billz_import, "fetch", fake)
    rep = {}
    rows = billz_import._safe_pages("t", "/v1/transaction-report-table", "rows", {"start_date": "2026-10-01"}, rep, ["s1", "s2"])
    assert rows == [{"order_id": "o1"}] and "warnings" not in rep and seen[-1]["shop_ids"] == "s1,s2"


def test_billz_pages_when_limit_is_capped(monkeypatch):
    from app.services import billz_import
    data = [{"id": i} for i in range(250)]

    def fake(method, path, token=None, body=None, params=None):
        lim = min(params["limit"], 100)  # BILLZ молча урезает limit
        st = (params["page"] - 1) * lim
        return {"count": len(data), "products": data[st:st + lim]}
    monkeypatch.setattr(billz_import, "fetch", fake)
    assert len(billz_import._pages("t", "/v2/products", "products")) == 250


def test_billz_catalog_pages(client, monkeypatch):
    from app.services import billz_import
    data = [{"id": f"p{i}", "name": f"Товар {i}", "sku": f"S{i}", "supply_price": 10,
             "shop_prices": [{"shop_id": "s1", "retail_price": 20}],
             "shop_measurement_values": [{"shop_id": "s1", "active_measurement_value": 3}]} for i in range(150)]

    def fake(method, path, token=None, body=None, params=None):
        if path == "/v1/auth/login":
            return {"data": {"access_token": "t"}}
        if path == "/v1/shop":
            return {"count": 1, "shops": [{"id": "s1", "name": "Склад"}]}
        if path == "/v2/category":
            return {"count": 0, "categories": []}
        if path == "/v2/product-search-with-filters":
            st = (body["page"] - 1) * 100
            return {"count": 150, "products": [{**d, "shop_prices": [{"shop_id": "s1", "retail_price": 20, "wholesale_price": 15}],
                                                "shop_measurement_values": [{"shop_id": "s1", "total_active_measurement_value": 3}]}
                                               for d in data[st:st + 100]]}
        return {}
    monkeypatch.setattr(billz_import, "fetch", fake)
    h = register(client)
    r1 = client.post("/api/import/billz", json={"secret_token": "good-token-1234567890", "step": "catalog", "page": 1}, headers=h).json()
    assert r1["next_page"] == 2 and r1["products_created"] == 100
    r2 = client.post("/api/import/billz", json={"secret_token": "good-token-1234567890", "step": "catalog", "page": 2}, headers=h).json()
    assert r2["next_page"] is None and r2["products_created"] == 50
    p = client.get("/api/products?q=S149", headers=h).json()["items"][0]
    assert p["retail_price"] == 20 and p["cost_price"] == 10 and p["stock_total"] == 3 and p["wholesale_price"] == 15
    assert r1["stock_stores"] == ["Чиланзар"]  # единственный магазин тут и в BILLZ — связались, а не задвоились
