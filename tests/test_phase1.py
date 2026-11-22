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
    calls = []

    def fake(method, path, token=None, body=None, params=None):
        calls.append(path)
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
        if path == "/v1/client":
            return {"count": 1, "clients": [{"first_name": "Азиз", "last_name": "Каримов", "phone_numbers": ["998901112233"], "gender": "male", "birth_date": "1990-05-14"}]}
        return {}
    monkeypatch.setattr(billz_import, "fetch", fake)
    h = register(client)
    bad = client.post("/api/import/billz", json={"secret_token": "wrong-token-1234567890"}, headers=h)
    assert bad.status_code == 422
    r = client.post("/api/import/billz", json={"secret_token": "good-token-1234567890"}, headers=h)
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["stores_created"] == 1 and rep["categories_created"] == 2 and rep["products_created"] == 1 and rep["clients_created"] == 1
    p = client.get("/api/products?q=M008", headers=h).json()["items"][0]
    assert p["retail_price"] == 100 and p["cost_price"] == 36 and p["stock_total"] == 7
    c = client.get("/api/clients?q=Азиз", headers=h).json()["items"][0]
    assert c["phone"] == "+998901112233" and c["gender"] == "m" and c["birth_date"] == "1990-05-14"
    # повторный импорт ничего не дублирует
    rep2 = client.post("/api/import/billz", json={"secret_token": "good-token-1234567890"}, headers=h).json()
    assert rep2["products_created"] == 0 and rep2["products_updated"] == 1 and rep2["clients_created"] == 0 and rep2["stock_lines"] == 0
