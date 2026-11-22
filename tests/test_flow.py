from tests.conftest import register


def setup_catalog(c, h):
    store = c.get("/api/stores", headers=h).json()[0]["id"]
    cat = c.post("/api/categories", json={"name": "Укладка"}, headers=h).json()["id"]
    a = c.post("/api/products", json={"name": "Помада матовая", "sku": "M002", "barcode": "5012521100034",
                                      "category_id": cat, "cost_price": 10, "retail_price": 22}, headers=h).json()["id"]
    b = c.post("/api/products", json={"name": "Шампунь", "sku": "S001", "cost_price": 8, "retail_price": 19},
               headers=h).json()["id"]
    svc = c.post("/api/products", json={"name": "Стрижка", "is_service": True, "retail_price": 15}, headers=h).json()["id"]
    doc = c.post("/api/stock/supplier_order", json={"store_id": store, "items": [
        {"product_id": a, "qty": 10, "price": 11}, {"product_id": b, "qty": 3}]}, headers=h).json()
    r = c.post(f"/api/stock/supplier_order/{doc['id']}/complete", headers=h)
    assert r.status_code == 200, r.text
    return store, cat, a, b, svc


def test_full_cash_register_flow(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)

    p = c.get(f"/api/products/{a}", headers=h).json()
    assert p["stock_total"] == 10 and p["cost_price"] == 11
    assert c.get("/api/products/barcode/5012521100034", headers=h).json()["id"] == a
    stats = c.get("/api/products/stats", headers=h).json()
    assert stats == {"all": 3, "active": 3, "inactive": 0, "low_stock": 1, "zero_stock": 0}

    # нехватка товара
    r = c.post("/api/sales", json={"store_id": store, "items": [{"product_id": b, "qty": 5}],
                                  "payments": [{"method": "cash", "amount": 95}]}, headers=h)
    assert r.status_code == 409

    # клиент из группы со скидкой 10% и акция 20% на категорию: берётся большая скидка
    g = c.post("/api/client-groups", json={"name": "VIP", "discount_percent": 10}, headers=h).json()["id"]
    cl = c.post("/api/clients", json={"name": "Азиз", "phone": "+998901112233", "group_id": g}, headers=h).json()["id"]
    c.post("/api/marketing/promotions", json={"name": "Неделя укладки", "discount_percent": 20, "category_ids": [cat]},
           headers=h)
    items = [{"product_id": a, "qty": 2}, {"product_id": b, "qty": 1}, {"product_id": svc, "qty": 1}]
    q = c.post("/api/sales/quote", json={"store_id": store, "client_id": cl, "items": items}, headers=h).json()
    # 44*0.8=35.20, 19*0.9=17.10, 15*0.9=13.50
    assert q["subtotal"] == 78 and q["total"] == 65.8

    # оплата не сходится
    bad = c.post("/api/sales", json={"store_id": store, "client_id": cl, "items": items,
                                    "payments": [{"method": "cash", "amount": 60}]}, headers=h)
    assert bad.status_code == 422

    sale = c.post("/api/sales", json={"store_id": store, "client_id": cl, "items": items, "payments": [
        {"method": "cash", "amount": 40}, {"method": "debt", "amount": 25.8}]}, headers=h)
    assert sale.status_code == 201, sale.text
    sale = sale.json()
    assert sale["total"] == 65.8 and sale["number"] == 1
    assert c.get(f"/api/products/{a}", headers=h).json()["stock_total"] == 8
    assert c.get(f"/api/clients/{cl}", headers=h).json()["debt_balance"] == 25.8

    # частичный возврат одной помады в счёт долга
    line = next(i for i in sale["items"] if i["product_id"] == a)
    r = c.post(f"/api/sales/{sale['id']}/returns", json={"items": [{"sale_item_id": line["id"], "qty": 1}],
                                                         "refund_method": "debt"}, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["amount"] == 17.6
    assert c.get(f"/api/clients/{cl}", headers=h).json()["debt_balance"] == 8.2
    assert c.get(f"/api/products/{a}", headers=h).json()["stock_total"] == 9
    over = c.post(f"/api/sales/{sale['id']}/returns", json={"items": [{"sale_item_id": line["id"], "qty": 2}],
                                                            "refund_method": "cash"}, headers=h)
    assert over.status_code == 422

    # клиент гасит остаток долга
    assert c.post(f"/api/clients/{cl}/debt-payments", json={"amount": 8.2, "method": "card"}, headers=h).status_code == 201
    assert c.get("/api/clients/debts/summary", headers=h).json() == {"total_debt": 0.0, "debtors": 0}

    # отложенный чек: склад не трогается до проведения
    held = c.post("/api/sales", json={"store_id": store, "items": [{"product_id": a, "qty": 1}], "hold": True},
                  headers=h).json()
    assert held["status"] == "held"
    assert c.get(f"/api/products/{a}", headers=h).json()["stock_total"] == 9
    assert len(c.get(f"/api/sales/held?store_id={store}", headers=h).json()) == 1
    done = c.post(f"/api/sales/{held['id']}/complete", json={"payments": [{"method": "card", "amount": 17.6}]},
                  headers=h)
    assert done.status_code == 200, done.text
    assert c.get(f"/api/products/{a}", headers=h).json()["stock_total"] == 8

    # главная
    d = c.get("/api/reports/dashboard", headers=h).json()
    assert d["revenue"] == {"gross": 83.4, "returns": 17.6, "net": 65.8}
    assert d["payments"]["cash"] == 40 and d["payments"]["debt"] == 25.8 and d["payments"]["card"] == 17.6
    assert d["transactions"]["count"] == 2 and d["transactions"]["services_qty"] == 1
    assert d["top_products"][0]["product_id"] == a
    assert sum(day["net"] for day in d["by_day"]) == 65.8
    from datetime import date, timedelta
    today = date.today()
    c.post("/api/targets", json={"period_start": str(today - timedelta(days=3)), "period_end": str(today + timedelta(days=3)),
                                 "amount": 658}, headers=h)
    tgt = c.get("/api/reports/dashboard", headers=h).json()["target"]
    assert tgt["done"] == 65.8 and tgt["percent"] == 10.0
    assert c.get("/api/reports/products", headers=h).status_code == 200
    assert c.get("/api/reports/sellers", headers=h).json()[0]["checks"] == 2


def test_stock_documents(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)
    store2 = c.post("/api/stores", json={"name": "Юнусабад"}, headers=h).json()["id"]

    t = c.post("/api/stock/transfer", json={"store_id": store, "to_store_id": store2,
                                            "items": [{"product_id": a, "qty": 4}]}, headers=h).json()
    c.post(f"/api/stock/transfer/{t['id']}/complete", headers=h)
    assert c.get(f"/api/products/{a}", headers=h).json()["stock"] == {str(store): 6, str(store2): 4}

    inv = c.post("/api/stock/inventory", json={"store_id": store, "items": [{"product_id": a, "qty": 5}]}, headers=h).json()
    done = c.post(f"/api/stock/inventory/{inv['id']}/complete", headers=h).json()
    assert done["items"][0]["expected_qty"] == 6
    assert c.post(f"/api/stock/inventory/{inv['id']}/complete", headers=h).status_code == 409

    assert c.post("/api/stock/writeoff", json={"store_id": store, "items": [{"product_id": a, "qty": 1}]},
                  headers=h).status_code == 422  # нужна причина
    w = c.post("/api/stock/writeoff", json={"store_id": store, "reason": "Брак",
                                            "items": [{"product_id": a, "qty": 1}]}, headers=h).json()
    c.post(f"/api/stock/writeoff/{w['id']}/complete", headers=h)

    rp = c.post("/api/stock/repricing", json={"items": [{"product_id": a, "price": 25}]}, headers=h).json()
    rp = c.post(f"/api/stock/repricing/{rp['id']}/complete", headers=h).json()
    assert rp["items"][0]["old_price"] == 22
    p = c.get(f"/api/products/{a}", headers=h).json()
    assert p["retail_price"] == 25 and p["stock"][str(store)] == 4

    reasons = [m["reason"] for m in c.get(f"/api/products/{a}/movements", headers=h).json()]
    assert set(reasons) == {"supplier_order", "transfer_out", "transfer_in", "inventory", "writeoff"}


def test_promo_codes_bonuses_and_import(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)
    c.patch("/api/company", json={"loyalty_percent": 5, "max_bonus_payment_percent": 50}, headers=h)
    cl = c.post("/api/clients", json={"name": "Малика", "phone": "+998907778899"}, headers=h).json()["id"]

    c.post("/api/marketing/promo-codes", json={"code": "minus5", "discount_amount": 5, "max_uses": 1}, headers=h)
    s = c.post("/api/sales", json={"store_id": store, "client_id": cl, "promo_code": "MINUS5",
                                  "items": [{"product_id": a, "qty": 1}, {"product_id": b, "qty": 1}],
                                  "payments": [{"method": "cash", "amount": 36}]}, headers=h)
    assert s.status_code == 201, s.text
    assert s.json()["discount"] == 5 and s.json()["bonus_earned"] == 1.8
    again = c.post("/api/sales/quote", json={"store_id": store, "promo_code": "minus5",
                                            "items": [{"product_id": a, "qty": 1}]}, headers=h)
    assert again.status_code == 422

    # бонусами можно оплатить не больше 50% и не больше баланса
    too_much = c.post("/api/sales", json={"store_id": store, "client_id": cl, "bonus_to_use": 5,
                                         "items": [{"product_id": a, "qty": 1}],
                                         "payments": [{"method": "cash", "amount": 17}]}, headers=h)
    assert too_much.status_code == 422
    ok = c.post("/api/sales", json={"store_id": store, "client_id": cl, "bonus_to_use": 1.8,
                                   "items": [{"product_id": a, "qty": 1}],
                                   "payments": [{"method": "cash", "amount": 20.2}]}, headers=h)
    assert ok.status_code == 201, ok.text
    assert c.get(f"/api/clients/{cl}", headers=h).json()["bonus_balance"] == 1.01  # 0 + 5% от 20.20

    csv_data = "name;sku;barcode;category;supplier;cost_price;retail_price;qty\n" \
               "Масло для бороды;B050;111;Борода;Proraso;7;18;12\n" \
               "Помада матовая;M002;;;;;23,5;5\n" \
               "Без цены;X1;;;;abc;;\n"
    r = c.post(f"/api/products/import?store_id={store}", files={"file": ("p.csv", csv_data.encode(), "text/csv")},
               headers=h).json()
    assert r["created"] == 1 and r["updated"] == 1 and len(r["errors"]) == 1
    found = c.get("/api/products?q=B050", headers=h).json()
    assert found["total"] == 1 and found["items"][0]["stock_total"] == 12

    sms = c.post("/api/marketing/sms", json={"text": "Скидка 10% в выходные"}, headers=h)
    assert sms.status_code == 201 and len(sms.json()["recipients"]) == 1
    assert c.get("/api/reports/marketing", headers=h).json()["bonus_paid"] == 1.8


def test_roles_and_isolation(client):
    c = client
    h = register(c)
    store, cat, a, b, svc = setup_catalog(c, h)
    store2 = c.post("/api/stores", json={"name": "Юнусабад"}, headers=h).json()["id"]
    cashier_role = next(r for r in c.get("/api/roles", headers=h).json() if r["name"] == "Кассир")["id"]
    c.post("/api/users", json={"name": "Рустам", "login": "rustam", "password": "kassa1234",
                               "role_id": cashier_role, "store_ids": [store]}, headers=h)
    tok = c.post("/api/auth/login", data={"username": "rustam", "password": "kassa1234"}).json()["access_token"]
    k = {"Authorization": f"Bearer {tok}"}
    assert c.post("/api/auth/login", data={"username": "rustam", "password": "wrong"}).status_code == 401

    assert c.post("/api/sales", json={"store_id": store, "items": [{"product_id": a, "qty": 1}],
                                     "payments": [{"method": "card", "amount": 22}]}, headers=k).status_code == 201
    assert c.post("/api/sales", json={"store_id": store2, "items": [{"product_id": a, "qty": 1}],
                                     "payments": [{"method": "card", "amount": 22}]}, headers=k).status_code == 403
    assert c.post("/api/sales", json={"store_id": store, "items": [{"product_id": a, "qty": 1, "price": 1}],
                                     "payments": [{"method": "card", "amount": 1}]}, headers=k).status_code == 403
    assert c.get("/api/reports/dashboard", headers=k).status_code == 403
    assert c.post("/api/products", json={"name": "X"}, headers=k).status_code == 403
    assert "sales.create" in c.get("/api/auth/me", headers=k).json()["permissions"]

    # другая компания не видит чужие товары
    other = register(c, login="owner2", company="Другой магазин")
    assert c.get(f"/api/products/{a}", headers=other).status_code == 404
    assert c.get("/api/products", headers=other).json()["total"] == 0
    assert c.get("/api/products", headers={"Authorization": "Bearer bad"}).status_code == 401
