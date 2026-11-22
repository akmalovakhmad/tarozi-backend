"""Демо-данные: компания, 2 магазина, товары, клиенты и неделя продаж.
Запуск: python seed.py  →  вход: логин demo, пароль demo12345"""
import random
from datetime import timedelta

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Sale, now

random.seed(7)

with TestClient(app) as c:
    r = c.post("/api/auth/register", json={"company_name": "Barber Shop", "store_name": "Чиланзар",
                                          "owner_name": "Дилшод Каримов", "login": "demo", "password": "demo12345"})
    if r.status_code == 409:
        raise SystemExit("Демо-данные уже есть (логин demo занят)")
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    c.patch("/api/company", json={"loyalty_percent": 3}, headers=h)
    store = c.get("/api/stores", headers=h).json()[0]["id"]
    c.post("/api/stores", json={"name": "Юнусабад"}, headers=h)

    cats = {n: c.post("/api/categories", json={"name": n}, headers=h).json()["id"]
            for n in ("Укладка", "Уход", "Борода", "Бритьё", "Наборы")}
    goods = [("Помада для укладки, матовая", "Укладка", 11, 22), ("Глина для волос", "Укладка", 12, 24),
             ("Шампунь восстанавливающий 250 мл", "Уход", 9, 19), ("Шампунь мужской 250 мл", "Уход", 7, 16.5),
             ("Масло для бороды 50 мл", "Борода", 8, 18), ("Бальзам для бороды", "Борода", 6, 15),
             ("Гель для бритья 150 мл", "Бритьё", 5, 12), ("Лосьон после бритья", "Бритьё", 6, 14),
             ("Подарочный набор «Барбер»", "Наборы", 25, 49)]
    ids = []
    for i, (name, cat, cost, price) in enumerate(goods, 1):
        ids.append(c.post("/api/products", json={"name": name, "sku": f"T{i:03}", "barcode": f"47800000{i:05}",
                                                 "category_id": cats[cat], "cost_price": cost, "retail_price": price},
                          headers=h).json()["id"])
    doc = c.post("/api/stock/supplier_order", json={"store_id": store, "items": [
        {"product_id": p, "qty": random.randint(20, 60)} for p in ids]}, headers=h).json()
    c.post(f"/api/stock/supplier_order/{doc['id']}/complete", headers=h)

    clients = [c.post("/api/clients", json={"name": n, "phone": f"+99890{1000000 + i}"}, headers=h).json()["id"]
               for i, n in enumerate(["Азиз", "Малика", "Бекзод", "Нигора", "Тимур"])]

    sale_ids = []
    for _ in range(60):
        items = [{"product_id": p, "qty": random.randint(1, 2)} for p in random.sample(ids, random.randint(1, 3))]
        client = random.choice(clients + [None, None])
        q = c.post("/api/sales/quote", json={"store_id": store, "items": items}, headers=h).json()
        method = random.choice(["cash", "cash", "card"] + (["debt"] if client else []))
        s = c.post("/api/sales", json={"store_id": store, "client_id": client, "items": items,
                                      "payments": [{"method": method, "amount": q["total"]}]}, headers=h)
        sale_ids.append(s.json()["id"])

# раскидываем продажи по последней неделе, чтобы график на главной был живым
db = SessionLocal()
for sid in sale_ids:
    db.get(Sale, sid).created_at = now() - timedelta(days=random.randint(0, 6), hours=random.randint(0, 9))
db.commit()
print("Готово. Вход: логин demo, пароль demo12345")
