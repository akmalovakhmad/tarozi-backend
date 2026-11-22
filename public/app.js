/* Тарози — фронтенд. Без сборки: один файл, работает с API на том же адресе (/api/...). */
(() => {
'use strict';

// ---------- утилиты ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const num = v => nf.format(+v || 0);
const money = v => `${num(v)} ${S.company?.currency || ''}`.trim();
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = () => iso(new Date());
const utc = s => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z'); // сервер отдаёт время в UTC без зоны
const fTime = s => utc(s).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fDateTime = s => utc(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fDay = s => new Date(s + 'T00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const PAY = { cash: 'Наличные', card: 'Карта', debt: 'В долг', bonus: 'Бонусы' };
const PAY_TAG = { cash: 'green', card: '', debt: 'red', bonus: 'amber' };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const can = p => !!S.me?.permissions?.includes(p);
const opts = (list, sel, val = 'id', label = 'name', empty) =>
  (empty != null ? `<option value="">${esc(empty)}</option>` : '') +
  list.map(x => `<option value="${esc(x[val])}" ${String(x[val]) === String(sel ?? '') ? 'selected' : ''}>${esc(x[label])}</option>`).join('');
const initials = n => (n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const PALETTE = [['#DCE5FB', '#1E4BD2'], ['#D3F0EC', '#0F7A6E'], ['#FBE7D3', '#9A5A12'], ['#F6DDE1', '#B02A3E'], ['#E9E3FB', '#5B3FC4']];
const tint = id => PALETTE[(+id || 0) % PALETTE.length];

// ---------- состояние ----------
const S = { token: store.get('tz_token'), me: null, company: null, stores: [], storeId: +store.get('tz_store') || null, cats: [] };

// ---------- API ----------
const FIELD = { login: 'Логин', password: 'Пароль', name: 'Название', company_name: 'Название бизнеса', store_name: 'Магазин',
  owner_name: 'Ваше имя', amount: 'Сумма', qty: 'Количество', retail_price: 'Цена', cost_price: 'Себестоимость', code: 'Код',
  discount_percent: 'Скидка', phone: 'Телефон', text: 'Текст', items: 'Товары', period_start: 'Начало', period_end: 'Конец' };
function errText(d) {
  if (!d) return '';
  if (typeof d.detail === 'string') return d.detail;
  if (Array.isArray(d.detail)) return d.detail.map(e => {
    const f = FIELD[e.loc?.[e.loc.length - 1]] || e.loc?.[e.loc.length - 1] || 'Поле';
    const c = e.ctx || {};
    const m = { missing: 'обязательное поле', string_too_short: `минимум ${c.min_length} символов`, greater_than: `должно быть больше ${c.gt}`,
      greater_than_equal: `не меньше ${c.ge}`, less_than_equal: `не больше ${c.le}`, too_short: 'добавьте хотя бы одну позицию',
      decimal_parsing: 'нужно число', int_parsing: 'нужно целое число', date_from_datetime_parsing: 'неверная дата' }[e.type] || e.msg;
    return `${f}: ${m}`;
  }).join('; ');
  return '';
}
async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  let payload = form;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  try { r = await fetch(path, { method, headers, body: payload }); }
  catch { throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз'); }
  if (r.status === 401 && S.token && !path.includes('/auth/')) { logout(); throw new Error('Сессия закончилась, войдите снова'); }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(errText(data) || `Ошибка сервера (${r.status})`);
  return data;
}
const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && v !== false) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };

// ---------- toast & modal ----------
function toast(msg, bad) {
  $('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 3800);
}
function modal(title, html, { wide } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-h"><h2>${esc(title)}</h2><button class="x" type="button" aria-label="Закрыть" data-close>×</button></div>
    <div class="modal-b">${html}</div></div>`;
  const prev = document.activeElement;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  bg.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  setTimeout(() => (bg.querySelector('input:not([type=hidden]),select,textarea') || bg.querySelector('.x')).focus(), 30);
  return { el: bg, body: $('.modal-b', bg), close };
}
// форма в модалке: onSubmit(data, m) — бросает ошибку → показываем её в форме
function formModal(title, fields, onSubmit, { submit = 'Сохранить', wide, extra = '' } = {}) {
  const m = modal(title, `<form class="form" novalidate>${fields}${extra}<div class="err" hidden></div>
    <div class="modal-f"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn" type="submit">${esc(submit)}</button></div></form>`, { wide });
  const f = $('form', m.el);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', f), err = $('.err', f);
    btn.disabled = true; err.hidden = true;
    try { await onSubmit(Object.fromEntries(new FormData(f)), m, f); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { btn.disabled = false; }
  });
  return m;
}
const field = (label, input) => `<label class="field"><span>${esc(label)}</span>${input}</label>`;
const inp = (name, { type = 'text', value = '', req, ph = '', step, min, attrs = '' } = {}) =>
  `<input class="input" name="${name}" type="${type}" value="${esc(value)}" ${req ? 'required' : ''} placeholder="${esc(ph)}" ${step ? `step="${step}"` : ''} ${min != null ? `min="${min}"` : ''} ${attrs}>`;
const nOrNull = v => (v === '' || v == null ? null : +String(v).replace(',', '.'));

// ---------- иконки ----------
const I = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  dashboard: I('<path d="M3 12l9-8 9 8M5 10v10h14V10"/>'),
  kassa: I('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 20h10M12 16v4M7 8h4"/>'),
  sales: I('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>'),
  products: I('<path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10"/>'),
  clients: I('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 11a3 3 0 1 0 0-6M22 21c0-3-2-5-5-5"/>'),
  marketing: I('<path d="M3 11v2l13 5V6zM16 8a4 4 0 0 1 0 8M6 14l1 5h3l-1-4"/>'),
  reports: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  staff: I('<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>'),
};
const LOGO = `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="9" fill="#1E4BD2"/><path d="M17 8v18M9 12h16M9 12l-3 7h6zM25 12l-3 7h6zM12 26h10" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------- маршруты ----------
const ROUTES = {
  dashboard: { t: 'Главная', perm: 'reports.read', render: viewDashboard },
  kassa: { t: 'Касса', perm: 'sales.create', render: viewKassa },
  sales: { t: 'Продажи', perm: 'sales.read', render: viewSales },
  products: { t: 'Товары', perm: 'products.read', render: viewProducts },
  clients: { t: 'Клиенты', perm: 'clients.read', render: viewClients },
  marketing: { t: 'Маркетинг', perm: 'marketing.manage', render: viewMarketing },
  reports: { t: 'Отчёты', perm: 'reports.read', render: viewReports },
  staff: { t: 'Сотрудники', perm: 'staff.manage', render: viewStaff },
  settings: { t: 'Настройки', perm: 'settings.manage', render: viewSettings },
};
const allowed = () => Object.keys(ROUTES).filter(k => can(ROUTES[k].perm));

async function boot() {
  if (!S.token) return renderAuth();
  try {
    [S.me, S.company, S.stores] = await Promise.all([api('/api/auth/me'), api('/api/company'), api('/api/stores')]);
    S.stores = S.stores.filter(s => s.is_active);
    if (!S.stores.some(s => s.id === S.storeId)) S.storeId = S.stores[0]?.id || null;
    store.set('tz_store', S.storeId);
    if (can('products.read')) S.cats = await api('/api/categories');
    renderShell(); route();
  } catch (e) { if (S.token) { logout(); toast(e.message, true); } }
}
function logout() { S.token = null; S.me = null; store.set('tz_token', null); renderAuth(); }

function renderShell() {
  const nav = allowed().map(k => `<a href="#${k}" data-r="${k}">${ICONS[k]}<span>${ROUTES[k].t}</span></a>`).join('');
  const role = S.me.is_owner ? 'Владелец' : 'Сотрудник';
  $('#root').innerHTML = `<div class="app">
    <header class="topbar"><button class="btn ghost sm" type="button" data-menu aria-label="Открыть меню">☰</button><b>Тарози</b></header>
    <nav class="side" aria-label="Разделы">
      <div class="brand">${LOGO}<span>Тарози</span></div>
      ${S.stores.length > 1 ? `<label class="store-pick field"><span>Магазин</span><select class="input" id="storeSel">${opts(S.stores, S.storeId)}</select></label>`
        : S.stores[0] ? `<p class="note" style="margin:0 12px 12px">${esc(S.stores[0].name)}</p>` : ''}
      <div class="nav">${nav}</div>
      <div class="me"><span class="avatar">${esc(initials(S.me.name))}</span><span class="who"><b>${esc(S.me.name)}</b><small>${role} · ${esc(S.company.name)}</small></span>
        <button class="btn link sm" type="button" data-logout>Выйти</button></div>
    </nav>
    <main class="main" id="view"></main></div>`;
  $('.app').addEventListener('click', e => {
    if (e.target.closest('[data-menu]')) $('.app').classList.toggle('menu-open');
    else if (e.target.closest('.nav a')) $('.app').classList.remove('menu-open');
    if (e.target.closest('[data-logout]')) logout();
  });
  $('#storeSel')?.addEventListener('change', e => { S.storeId = +e.target.value; store.set('tz_store', S.storeId); route(); });
}
function route() {
  if (!S.me) return;
  const list = allowed();
  let key = location.hash.slice(1);
  if (!list.includes(key)) { key = list[0]; if (!key) { $('#view').innerHTML = '<div class="panel empty">У вашей роли нет доступа ни к одному разделу. Попросите владельца выдать права.</div>'; return; } history.replaceState(null, '', '#' + key); }
  $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.r === key));
  document.title = `${ROUTES[key].t} — Тарози`;
  const v = $('#view');
  v.innerHTML = '<div class="empty">Загружаю…</div>'; v.classList.remove('has-cartbar');
  v.onclick = v.oninput = v.onchange = v.onkeydown = v.onsubmit = null;
  Promise.resolve(ROUTES[key].render(v)).catch(e => { v.innerHTML = `<div class="panel"><div class="err">${esc(e.message)}</div></div>`; });
}
window.addEventListener('hashchange', route);

// ---------- вход и регистрация ----------
function renderAuth(mode = 'login') {
  const reg = mode === 'register';
  $('#root').innerHTML = `<div class="auth">
    <section class="auth-art">
      <div class="brand" style="padding:0;color:#fff">${LOGO.replace('#1E4BD2', '#fff').replace('stroke="#fff"', 'stroke="#1E4BD2"')}<span>Тарози</span></div>
      <div><h1>Касса, склад и клиенты в одном окне</h1><p>Продавайте, принимайте товар, ведите долги клиентов и смотрите выручку по дням — с телефона или компьютера.</p></div>
      <div class="auth-tape" aria-hidden="true"><div><span>Помада матовая × 2</span><span>44.00</span></div><div><span>Шампунь 250 мл</span><span>19.00</span></div><div><span>Скидка VIP</span><span>−6.30</span></div><div style="border:0;font-weight:600"><span>Итого</span><span>56.70</span></div></div>
    </section>
    <section class="auth-form"><form class="box" novalidate>
      <div><h1 style="font-size:30px">${reg ? 'Регистрация магазина' : 'Вход'}</h1>
      <p class="sub">${reg ? 'Создадим ваш бизнес, первый магазин и аккаунт владельца.' : 'Войдите под своим логином и паролем.'}</p></div>
      ${reg ? field('Название бизнеса', inp('company_name', { req: true, ph: 'Например, Barber Shop' })) + field('Первый магазин', inp('store_name', { req: true, ph: 'Например, Чиланзар' })) + field('Ваше имя', inp('owner_name', { req: true })) : ''}
      ${field('Логин', inp('login', { req: true, attrs: 'autocomplete="username" autocapitalize="none"' }))}
      ${field('Пароль', inp('password', { type: 'password', req: true, attrs: `autocomplete="${reg ? 'new-password' : 'current-password'}"`, ph: reg ? 'Не меньше 8 символов' : '' }))}
      ${reg ? field('Валюта', `<select class="input" name="currency"><option>USD</option><option value="UZS">UZS (сум)</option><option>RUB</option><option>KZT</option><option>EUR</option></select>`) : ''}
      <div class="err" hidden></div>
      <button class="btn big" type="submit">${reg ? 'Создать и войти' : 'Войти'}</button>
      <p class="sub" style="text-align:center">${reg ? 'Уже есть аккаунт?' : 'Ещё нет аккаунта?'} <a href="#" data-switch>${reg ? 'Войти' : 'Зарегистрировать магазин'}</a></p>
    </form></section></div>`;
  const f = $('form');
  $('[data-switch]').onclick = e => { e.preventDefault(); renderAuth(reg ? 'login' : 'register'); };
  setTimeout(() => $('input', f)?.focus(), 30);
  f.onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f)), err = $('.err', f), btn = $('button[type=submit]', f);
    err.hidden = true; btn.disabled = true;
    try {
      const r = reg ? await api('/api/auth/register', { method: 'POST', body: d })
        : await api('/api/auth/login', { method: 'POST', form: new URLSearchParams({ username: d.login, password: d.password }) });
      S.token = r.access_token; store.set('tz_token', S.token);
      if (reg) location.hash = '#products';
      await boot();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { btn.disabled = false; }
  };
}

// ---------- периоды ----------
const PERIODS = { today: ['Сегодня', 0], week: ['Неделя', 6], month: ['Месяц', 29], quarter: ['Квартал', 89], year: ['Год', 364] };
function periodRange(key, shift = 0) {
  const days = PERIODS[key][1] + 1, end = addDays(new Date(), -shift * days);
  return { from: iso(addDays(end, -(days - 1))), to: iso(end) };
}
const segPeriods = (cur, keys = Object.keys(PERIODS)) => `<div class="seg" role="group" aria-label="Период">${keys.map(k =>
  `<button type="button" data-period="${k}" class="${k === cur ? 'on' : ''}" aria-pressed="${k === cur}">${PERIODS[k][0]}</button>`).join('')}</div>`;
const delta = (cur, prev) => {
  if (!prev) return cur ? '<small class="muted">нет данных за прошлый период</small>' : '<small>&nbsp;</small>';
  const p = Math.round((cur - prev) / prev * 100);
  return `<small class="${p >= 0 ? 'good' : 'bad'}">${p >= 0 ? '+' : ''}${p}% к прошлому периоду</small>`;
};

// ================= ГЛАВНАЯ =================
const D = { period: store.get('tz_period') || 'week', store: '' };
async function viewDashboard(v) {
  const r = periodRange(D.period), pr = periodRange(D.period, 1);
  const sq = D.store ? { store_id: D.store } : {};
  const [d, prev, todays] = await Promise.all([
    api('/api/reports/dashboard' + qs({ ...sq, date_from: r.from, date_to: r.to })),
    api('/api/reports/dashboard' + qs({ ...sq, date_from: pr.from, date_to: pr.to })),
    can('sales.read') ? api('/api/sales' + qs({ ...sq, date_from: today(), date_to: today(), size: 40 })) : null,
  ]);
  const label = { today: 'сегодня', week: 'неделю', month: 'месяц', quarter: 'квартал', year: 'год' }[D.period];
  const net = d.revenue.net, checks = d.transactions.count;
  const p = d.payments, payTotal = p.cash + p.card + p.debt + p.bonus;

  // график: по дням, за год — по месяцам
  let bars = d.by_day;
  if (D.period === 'year') {
    const m = new Map();
    for (const x of bars) { const k = x.date.slice(0, 7); const a = m.get(k) || { date: k, net: 0, cash: 0, card: 0, debt: 0, bonus: 0 }; for (const f of ['net', 'cash', 'card', 'debt', 'bonus']) a[f] += x[f]; m.set(k, a); }
    bars = [...m.values()];
  }
  const max = Math.max(1, ...bars.map(b => b.cash + b.card + b.debt + b.bonus));
  const every = Math.ceil(bars.length / 12);
  const barLabel = (b, i) => {
    if (b.date.length === 7) return `<b>${MONTHS[+b.date.slice(5) - 1]}</b>`;
    if (i % every) return '';
    const dd = new Date(b.date + 'T00:00');
    return bars.length <= 7 ? `<b>${WD[dd.getDay()]}</b><br>${fDay(b.date)}` : fDay(b.date);
  };
  const chart = `<div class="bars ${bars.length > 14 ? 'many' : ''}">${bars.map(b => {
    const t = b.cash + b.card + b.debt + b.bonus, pc = x => t ? (x / t * 100).toFixed(1) + '%' : '0';
    return `<div class="bar" title="${esc(`${b.date.length === 7 ? b.date : fDay(b.date)}: наличные ${num(b.cash)}, карта ${num(b.card)}, в долг ${num(b.debt)}${b.bonus ? `, бонусы ${num(b.bonus)}` : ''}`)}">
      <span class="v num">${t ? num(Math.round(t)) : ''}</span>
      <div class="stack" style="height:${(t / max * 86).toFixed(1)}%"><div style="height:${pc(b.bonus)};background:#E8A92E"></div><div style="height:${pc(b.debt)};background:var(--red)"></div><div style="height:${pc(b.card)};background:var(--card)"></div><div style="flex:1;background:var(--blue)"></div></div></div>`;
  }).join('')}</div><div class="xlab">${bars.map((b, i) => `<span>${barLabel(b, i)}</span>`).join('')}</div>`;

  const topP = d.top_products, maxP = Math.max(1, ...topP.map(x => x.net));
  const tgt = d.target;
  const tape = todays ? `<aside class="aside"><div class="tape">
      <div class="head" style="align-items:baseline"><h2>Чеки сегодня</h2>${S.stores.length ? '<span class="live">● касса открыта</span>' : ''}</div>
      <div class="line"></div>
      ${todays.items.length ? todays.items.slice(0, 12).map(s => `<div class="rcpt"><div class="t"><span class="muted">${fTime(s.created_at)} · №${s.number}</span><b>${money(s.total)}</b></div>
        <div class="t"><span>${esc(s.items.map(i => i.name).slice(0, 2).join(', '))}${s.items.length > 2 ? ` и ещё ${s.items.length - 2}` : ''}</span><span class="${s.payments.some(x => x.method === 'debt') ? 'bad' : 'good'}">${esc(s.payments.map(x => PAY[x.method]).join(' + '))}</span></div></div>`).join('')
        : '<p class="empty mono">Сегодня ещё не было продаж</p>'}
      <div class="t mono" style="display:flex;justify-content:space-between;padding-top:12px;font-weight:600"><span>Итого за день</span><span>${money(todays.items.reduce((a, s) => a + s.total - s.returned_total, 0))}</span></div>
      <div class="mono note" style="display:flex;justify-content:space-between"><span>Чеков</span><span>${todays.total}</span></div>
      <div style="display:grid;gap:8px;margin-top:14px">${can('sales.create') ? '<a class="btn" href="#kassa">Открыть кассу</a>' : ''}<a class="btn ghost" href="#sales">Все продажи</a></div>
    </div></aside>` : '';

  v.innerHTML = `
  <div class="head"><div><h1>${checks ? `Выручка за ${label}: ${money(net)}` : `За ${label} продаж нет`}</h1>
    <p class="sub">${r.from === r.to ? fDay(r.from) : `${fDay(r.from)} — ${fDay(r.to)}`}${checks ? `, ${checks} ${plural(checks, 'чек', 'чека', 'чеков')}` : '. Проведите первую продажу на кассе — она сразу появится здесь'}</p></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      ${S.stores.length > 1 ? `<select class="input" id="dStore" style="width:auto">${opts(S.stores, D.store, 'id', 'name', 'Все магазины')}</select>` : ''}
      ${segPeriods(D.period, ['today', 'week', 'month', 'year'])}</div></div>
  <div class="kpis">
    <div class="kpi"><span>Чистая выручка</span><b class="num">${money(net)}</b>${delta(net, prev.revenue.net)}</div>
    <div class="kpi"><span>Чеков</span><b class="num">${num(checks)}</b>${delta(checks, prev.transactions.count)}</div>
    <div class="kpi"><span>Средний чек</span><b class="num">${money(d.transactions.average_check)}</b><small class="muted">${num(d.transactions.goods_qty)} шт. товаров${d.transactions.services_qty ? `, ${num(d.transactions.services_qty)} услуг` : ''}</small></div>
    <div class="kpi"><span>Отдано в долг</span><b class="num ${p.debt ? 'bad' : ''}">${money(p.debt)}</b><small class="muted">${payTotal ? Math.round(p.debt / payTotal * 100) : 0}% от оплат${d.transactions.returns_count ? `, возвратов: ${d.transactions.returns_count}` : ''}</small></div>
  </div>
  <div class="row">
    <div class="grow grid">
      <section class="panel"><div class="head" style="align-items:baseline"><h2>Продажи по ${bars[0]?.date.length === 7 ? 'месяцам' : 'дням'} и способам оплаты</h2>
        <div class="legend"><span><i style="background:var(--blue)"></i>Наличные ${money(p.cash)}</span><span><i style="background:var(--card)"></i>Карта ${money(p.card)}</span><span><i style="background:var(--red)"></i>В долг ${money(p.debt)}</span>${p.bonus ? `<span><i style="background:#E8A92E"></i>Бонусы ${money(p.bonus)}</span>` : ''}</div></div>
        ${chart}</section>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
        <section class="panel"><h2>Лучшие товары</h2>${topP.length ? topP.slice(0, 6).map(x => `<div style="padding:8px 0;border-top:1px solid #EEF0F5">
          <div style="display:flex;justify-content:space-between;gap:12px"><span>${esc(x.name)} <small class="muted">· ${num(x.qty)} шт.</small></span><b class="num" style="white-space:nowrap">${money(x.net)}</b></div>
          <div class="meter"><div style="width:${(x.net / maxP * 100).toFixed(0)}%"></div></div></div>`).join('') : '<p class="empty">Нет продаж за период</p>'}</section>
        <section class="panel" style="display:grid;gap:12px;align-content:start"><h2>Продавцы и цель</h2>
          ${d.top_sellers.length ? d.top_sellers.slice(0, 4).map(x => { const [bg, fg] = tint(x.seller_id); return `<div style="display:flex;align-items:center;gap:12px">
            <span class="avatar" style="background:${bg};color:${fg}">${esc(initials(x.name))}</span><span style="flex:1">${esc(x.name)}</span><b class="num">${money(x.net)}</b></div>`; }).join('') : '<p class="muted" style="margin:0">Нет продаж за период</p>'}
          ${tgt ? `<div style="padding:14px 16px;background:var(--bg);border-radius:12px">
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:14px"><span>Цель до ${fDay(tgt.period_end)}</span><span class="num"><b>${num(tgt.done)}</b> из ${money(tgt.amount)}</span></div>
            <div class="meter teal"><div style="width:${Math.min(100, tgt.percent)}%"></div></div>
            <span class="note">${tgt.percent >= 100 ? 'Цель выполнена' : `Выполнено ${tgt.percent}%. Нужно продавать по ${money(tgt.per_day_needed)} в день`}</span></div>`
            : can('settings.manage') ? `<button class="btn ghost" type="button" data-a="target">Поставить цель по выручке</button>` : ''}
        </section></div>
    </div>${tape}</div>`;

  v.onclick = e => {
    const pb = e.target.closest('[data-period]');
    if (pb) { D.period = pb.dataset.period; store.set('tz_period', D.period); route(); }
    if (e.target.closest('[data-a=target]')) targetModal();
  };
  v.onchange = e => { if (e.target.id === 'dStore') { D.store = e.target.value; route(); } };
}
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many; };
function targetModal() {
  const now = new Date(), s = new Date(now.getFullYear(), now.getMonth(), 1), e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  formModal('Цель по выручке', `<p class="sub" style="margin:0">Цель — чистая выручка (продажи минус возвраты) за период. Прогресс будет на главной.</p>
    ${field('Сумма, ' + (S.company.currency || ''), inp('amount', { type: 'number', step: '0.01', min: 0, req: true }))}
    <div class="two">${field('С', inp('period_start', { type: 'date', value: iso(s) }))}${field('По', inp('period_end', { type: 'date', value: iso(e) }))}</div>
    ${S.stores.length > 1 ? field('Магазин', `<select class="input" name="store_id">${opts(S.stores, '', 'id', 'name', 'Все магазины')}</select>`) : ''}`,
  async (d, m) => {
    await api('/api/targets', { method: 'POST', body: { amount: nOrNull(d.amount), period_start: d.period_start, period_end: d.period_end, store_id: nOrNull(d.store_id) } });
    m.close(); toast('Цель сохранена'); route();
  }, { submit: 'Поставить цель' });
}

// ================= КАССА =================
const K = { cat: '', q: '', products: [], cart: [], client: null, pay: 'cash', received: '', promo: '', bonus: '', quote: null, qErr: '', done: null };
async function viewKassa(v) {
  if (!S.storeId) { v.innerHTML = '<div class="panel empty">Нет доступного магазина. Владелец может добавить магазин в настройках.</div>'; return; }
  const [prods] = await Promise.all([api('/api/products' + qs({ status: 'active', size: 500, store_id: S.storeId }))]);
  K.products = prods.items;
  drawKassa(v);
  bindKassa(v);
  requote();
}
const stockOf = p => +(p.stock?.[S.storeId] || 0);
function kassaTiles() {
  const q = K.q.trim().toLowerCase();
  const list = K.products.filter(p => (!K.cat || String(p.category_id) === K.cat) &&
    (!q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode || '') === q));
  if (!K.products.length) return `<div class="panel empty">В каталоге пока нет товаров. ${can('products.write') ? '<a href="#products">Добавьте первый товар</a>' : 'Попросите менеджера добавить товары'}.</div>`;
  if (!list.length) return '<div class="panel empty">Ничего не найдено. Проверьте название или отсканируйте штрихкод ещё раз.</div>';
  const neg = S.company.allow_negative_stock;
  return `<div class="tiles">${list.slice(0, 120).map(p => {
    const st = stockOf(p), out = !p.is_service && st <= 0 && !neg, [bg, fg] = tint(p.category_id || p.id);
    return `<button class="tile" type="button" data-add="${p.id}" ${out ? 'disabled' : ''}>
      <span class="pic" style="background:${bg};color:${fg}" aria-hidden="true">${esc(initials(p.name))}</span>
      <span class="nm">${esc(p.name)}</span>
      <span class="pr"><b class="num">${money(p.retail_price)}</b><small class="${p.is_service ? 'muted' : st <= 0 ? 'bad' : st <= +S.company.low_stock_threshold ? 'warn' : 'muted'}">${p.is_service ? 'услуга' : st <= 0 ? 'нет в наличии' : `${num(st)} ${esc(p.unit)}`}</small></span></button>`;
  }).join('')}</div>`;
}
function kassaCheck() {
  const q = K.quote, total = q?.total ?? 0, c = K.client;
  const bonusMax = q?.bonus_max_for_this_sale ?? 0, bonus = Math.min(+K.bonus || 0, bonusMax);
  const toPay = Math.max(0, +(total - bonus).toFixed(2));
  const change = K.pay === 'cash' && +K.received > toPay ? +K.received - toPay : 0;
  const lines = K.cart.map((l, i) => {
    const qi = q?.items?.[i];
    return `<div class="cart-line"><div class="t"><span>${esc(l.p.name)}</span><b class="num">${money(qi ? qi.total : l.p.retail_price * l.qty)}</b></div>
      ${qi?.discount ? `<div class="t note"><span>${esc(qi.promotion || 'Скидка')}</span><span>−${num(qi.discount)}</span></div>` : ''}
      <div class="qty"><button type="button" data-dec="${i}" aria-label="Меньше">−</button><input class="num" data-qty="${i}" value="${num(l.qty).replace(/\s/g, '')}" inputmode="decimal" aria-label="Количество">
      <button type="button" data-inc="${i}" aria-label="Больше">+</button><span style="margin-left:auto">× ${num(l.p.retail_price)}</span></div></div>`;
  }).join('');
  return `<div class="tape" style="display:grid;gap:14px">
    <div class="head" style="align-items:center"><h2>Новый чек</h2>${K.cart.length ? '<button class="btn link sm danger" style="border:0" type="button" data-clear>Очистить</button>' : ''}</div>
    ${c ? `<div class="client-box"><span class="avatar">${esc(initials(c.name))}</span><span style="flex:1;line-height:1.3"><b>${esc(c.name)}</b><br><small class="muted">${esc(c.phone || '')}${+c.bonus_balance ? ` · бонусы ${num(c.bonus_balance)}` : ''}${+c.debt_balance ? ` · <span class="bad">долг ${num(c.debt_balance)}</span>` : ''}</small></span><button class="btn link sm" type="button" data-unclient>Убрать</button></div>`
      : `<div class="dd"><div class="search" style="min-height:46px;border-style:dashed"><span aria-hidden="true">👤</span><input id="cSearch" placeholder="Клиент: имя или телефон" autocomplete="off" aria-label="Найти клиента"></div><div class="dd-list" id="cList" hidden></div></div>`}
    <div>${K.cart.length ? lines : '<p class="empty mono" style="padding:16px 0">Чек пустой. Отсканируйте штрихкод или выберите товар слева.</p>'}</div>
    ${K.cart.length ? `
    <div class="mono note" style="display:grid;gap:3px">
      <div style="display:flex;justify-content:space-between"><span>Без скидок</span><span>${num(q?.subtotal)}</span></div>
      <div style="display:flex;justify-content:space-between"><span>Скидка</span><span>${q?.discount ? '−' + num(q.discount) : '0'}</span></div></div>
    <div style="display:flex;gap:8px"><input class="input" id="promo" placeholder="Промокод" value="${esc(K.promo)}" style="min-height:40px;text-transform:uppercase" aria-label="Промокод"><button class="btn ghost sm" type="button" data-promo>Применить</button></div>
    ${K.qErr ? `<div class="err">${esc(K.qErr)}</div>` : ''}
    ${c && bonusMax > 0 ? `<label class="field"><span>Оплатить бонусами (до ${num(bonusMax)})</span><input class="input" id="bonus" type="number" min="0" step="0.01" max="${bonusMax}" value="${esc(K.bonus)}"></label>` : ''}
    <div class="total"><span style="font-weight:600">К оплате</span><b class="num">${num(toPay)}</b></div>
    <div class="pays" role="group" aria-label="Способ оплаты">${['cash', 'card', 'debt'].map(m => `<button type="button" data-pay="${m}" class="${K.pay === m ? 'on' : ''}" aria-pressed="${K.pay === m}">${PAY[m]}</button>`).join('')}</div>
    ${K.pay === 'cash' ? `<label class="field"><span>Получено от клиента</span><input class="input" id="recv" type="number" min="0" step="0.01" value="${esc(K.received)}" placeholder="${num(toPay)}"></label>${change ? `<div class="ok-msg">Сдача: ${money(change)}</div>` : ''}` : ''}
    ${K.pay === 'debt' && !c ? '<span class="bad note">Для продажи в долг выберите клиента.</span>' : ''}
    <button class="btn big" type="button" data-sell ${K.qErr || (K.pay === 'debt' && !c) ? 'disabled' : ''}>Принять оплату</button>
    <button class="btn link" type="button" data-hold>Отложить чек</button>` : ''}
    ${K.done ? `<div class="ok-msg" role="status">${esc(K.done)}</div>` : ''}
  </div>`;
}
function drawKassa(v) {
  v.innerHTML = `<div class="head"><div><h1>Касса</h1><p class="sub">${esc(S.stores.find(s => s.id === S.storeId)?.name || '')}, продавец ${esc(S.me.name)}</p></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost" type="button" data-held>Отложенные чеки</button>${can('sales.return') ? '<a class="btn ghost" href="#sales">Возврат</a>' : ''}</div></div>
  <div class="row"><section class="grow grid" aria-label="Товары">
    <label class="search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5A6280" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input id="kq" placeholder="Название, артикул или отсканируйте штрихкод" value="${esc(K.q)}" autocomplete="off" aria-label="Поиск товара"></label>
    <div class="chips" role="group" aria-label="Категории"><button type="button" class="chip ${!K.cat ? 'on' : ''}" data-cat="">Все</button>${S.cats.map(c => `<button type="button" class="chip ${K.cat === String(c.id) ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}</div>
    <div id="tiles">${kassaTiles()}</div></section>
    <aside class="aside" id="check" aria-label="Чек">${kassaCheck()}</aside></div>`;
}
function cartBar() {
  $('.cartbar')?.remove(); $('#view')?.classList.remove('has-cartbar');
  if (!K.cart.length || !$('#check')) return;
  const n = K.cart.reduce((a, l) => a + l.qty, 0), total = K.quote?.total ?? K.cart.reduce((a, l) => a + l.qty * l.p.retail_price, 0);
  const bar = document.createElement('div'); bar.className = 'cartbar';
  bar.innerHTML = `<span>${num(n)} ${plural(Math.round(n), 'товар', 'товара', 'товаров')} · <b class="num">${money(total)}</b></span><button class="btn sm" type="button">К чеку</button>`;
  bar.querySelector('button').onclick = () => $('#check').scrollIntoView({ behavior: 'smooth' });
  $('#view').append(bar); $('#view').classList.add('has-cartbar');
}
const redrawCheck = () => { cartBar(); const el = $('#check'); if (el) { const f = document.activeElement?.id; el.innerHTML = kassaCheck(); if (f && $('#' + f)) { const x = $('#' + f); x.focus(); const n = x.value.length; try { x.setSelectionRange(n, n); } catch { /* number input */ } } } };
const requote = debounce(async () => {
  K.done = null;
  if (!K.cart.length) { K.quote = null; K.qErr = ''; redrawCheck(); return; }
  try {
    K.quote = await api('/api/sales/quote', { method: 'POST', body: { store_id: S.storeId, client_id: K.client?.id, promo_code: K.promo || null, items: K.cart.map(l => ({ product_id: l.p.id, qty: l.qty })) } });
    K.qErr = '';
  } catch (e) { K.qErr = e.message; }
  redrawCheck();
}, 200);
function addToCart(p) {
  const l = K.cart.find(x => x.p.id === p.id);
  if (l) l.qty += 1; else K.cart.push({ p, qty: 1 });
  K.done = null; redrawCheck(); requote();
}
function bindKassa(v) {
  const searchClients = debounce(async q => {
    const box = $('#cList'); if (!box) return;
    if (!q.trim()) { box.hidden = true; return; }
    const r = await api('/api/clients' + qs({ q, size: 8 })).catch(() => ({ items: [] }));
    box.innerHTML = r.items.map(c => `<button type="button" data-client='${esc(JSON.stringify(c))}'><b>${esc(c.name)}</b> <span class="muted">${esc(c.phone || '')}</span></button>`).join('') +
      (can('clients.write') ? `<button type="button" data-newclient="${esc(q)}">+ Новый клиент «${esc(q)}»</button>` : '');
    box.hidden = false;
  }, 250);
  v.oninput = e => {
    const t = e.target;
    if (t.id === 'kq') { K.q = t.value; $('#tiles').innerHTML = kassaTiles(); }
    if (t.id === 'cSearch') searchClients(t.value);
    if (t.id === 'recv') { K.received = t.value; redrawCheck(); }
    if (t.id === 'bonus') { K.bonus = t.value; redrawCheck(); }
    if (t.id === 'promo') K.promo = t.value.trim().toUpperCase();
  };
  v.onchange = e => {
    const i = e.target.dataset.qty;
    if (i != null) { const q = nOrNull(e.target.value); if (q > 0) K.cart[i].qty = q; else K.cart.splice(i, 1); redrawCheck(); requote(); }
  };
  v.onkeydown = async e => {
    if (e.target.id === 'kq' && e.key === 'Enter') {
      e.preventDefault();
      const code = K.q.trim(); if (!code) return;
      let p = K.products.find(x => x.barcode === code || x.sku === code);
      if (!p) { const vis = K.products.filter(x => x.name.toLowerCase().includes(code.toLowerCase())); if (vis.length === 1) p = vis[0]; }
      if (!p) { try { p = await api('/api/products/barcode/' + encodeURIComponent(code)); } catch { toast(`Товар «${code}» не найден`, true); return; } }
      addToCart(p); K.q = ''; e.target.value = ''; $('#tiles').innerHTML = kassaTiles();
    }
    if (e.target.id === 'promo' && e.key === 'Enter') { e.preventDefault(); requote(); }
  };
  v.onclick = async e => {
    const t = e.target.closest('button,a'); if (!t) return;
    const d = t.dataset;
    if (d.add) addToCart(K.products.find(p => p.id === +d.add));
    else if (d.cat != null) { K.cat = d.cat; $$('.chip', v).forEach(c => c.classList.toggle('on', c.dataset.cat === d.cat)); $('#tiles').innerHTML = kassaTiles(); }
    else if (d.inc) { K.cart[d.inc].qty += 1; redrawCheck(); requote(); }
    else if (d.dec) { const l = K.cart[d.dec]; l.qty -= 1; if (l.qty <= 0) K.cart.splice(d.dec, 1); redrawCheck(); requote(); }
    else if ('clear' in d) { Object.assign(K, { cart: [], client: null, promo: '', bonus: '', received: '', quote: null, qErr: '' }); redrawCheck(); }
    else if (d.pay) { K.pay = d.pay; redrawCheck(); }
    else if ('promo' in d) requote();
    else if (d.client) { K.client = JSON.parse(d.client); K.bonus = ''; redrawCheck(); requote(); }
    else if ('unclient' in d) { K.client = null; K.bonus = ''; if (K.pay === 'debt') K.pay = 'cash'; redrawCheck(); requote(); }
    else if (d.newclient != null) clientModal(null, c => { K.client = c; redrawCheck(); requote(); }, { name: d.newclient });
    else if ('sell' in d) sell(false);
    else if ('hold' in d) sell(true);
    else if ('held' in d) heldModal();
  };
}
async function sell(hold) {
  const q = K.quote; if (!q || !K.cart.length) return;
  const bonus = Math.min(+K.bonus || 0, q.bonus_max_for_this_sale || 0);
  const toPay = +(q.total - bonus).toFixed(2);
  const btn = $(hold ? '[data-hold]' : '[data-sell]'); if (btn) btn.disabled = true;
  try {
    const sale = await api('/api/sales', { method: 'POST', body: {
      store_id: S.storeId, client_id: K.client?.id, promo_code: K.promo || null, hold,
      items: K.cart.map(l => ({ product_id: l.p.id, qty: l.qty })),
      bonus_to_use: hold ? 0 : bonus, payments: hold || toPay <= 0 ? [] : [{ method: K.pay, amount: toPay }],
    } });
    const change = !hold && K.pay === 'cash' && +K.received > toPay ? +K.received - toPay : 0;
    Object.assign(K, { cart: [], client: null, promo: '', bonus: '', received: '', quote: null, qErr: '', pay: 'cash' });
    K.done = hold ? `Чек №${sale.number} отложен. Найдёте его в «Отложенных чеках».` : `Продажа №${sale.number} проведена: ${money(sale.total)}${change ? `. Сдача ${money(change)}` : ''}${sale.bonus_earned ? `. Начислено бонусов: ${num(sale.bonus_earned)}` : ''}`;
    const prods = await api('/api/products' + qs({ status: 'active', size: 500, store_id: S.storeId }));
    K.products = prods.items; $('#tiles').innerHTML = kassaTiles(); redrawCheck();
  } catch (e) { toast(e.message, true); if (btn) btn.disabled = false; }
}
async function heldModal() {
  const list = await api('/api/sales/held' + qs({ store_id: S.storeId }));
  const m = modal('Отложенные чеки', list.length ? list.map(s => `<div class="rcpt" style="font-size:14px">
    <div class="t"><span>№${s.number} · ${fDateTime(s.created_at)}</span><b>${money(s.total)}</b></div>
    <div class="t"><span>${esc(s.items.map(i => `${i.name} × ${num(i.qty)}`).join(', '))}</span></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn sm" data-paid="${s.id}" data-m="cash">Оплатить наличными</button><button class="btn sm" data-paid="${s.id}" data-m="card">Картой</button>
    ${s.client_id ? `<button class="btn sm ghost" data-paid="${s.id}" data-m="debt">В долг</button>` : ''}<button class="btn sm danger" data-cancel="${s.id}">Отменить</button></div></div>`).join('')
    : '<p class="empty">Отложенных чеков нет.</p>');
  m.body.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const s = list.find(x => x.id === +(b.dataset.paid || b.dataset.cancel)); if (!s) return;
    b.disabled = true;
    try {
      if (b.dataset.paid) { const r = await api(`/api/sales/${s.id}/complete`, { method: 'POST', body: { payments: [{ method: b.dataset.m, amount: s.total }] } }); toast(`Чек №${r.number} оплачен`); }
      else { await api(`/api/sales/${s.id}/cancel`, { method: 'POST' }); toast(`Чек №${s.number} отменён`); }
      m.close(); heldModal();
    } catch (x) { toast(x.message, true); b.disabled = false; }
  };
}

// ================= ПРОДАЖИ =================
const SL = { period: 'week', status: 'completed', page: 1, num: '' };
async function viewSales(v) {
  const r = periodRange(SL.period);
  const [res, clients] = await Promise.all([
    api('/api/sales' + qs({ store_id: S.stores.length > 1 ? S.storeId : '', status: SL.status, number: SL.num, date_from: SL.num ? '' : r.from, date_to: SL.num ? '' : r.to, page: SL.page, size: 50 })),
    can('clients.read') ? api('/api/clients' + qs({ size: 500 })) : { items: [] },
  ]);
  const cn = Object.fromEntries(clients.items.map(c => [c.id, c.name]));
  const sum = res.items.reduce((a, s) => a + s.total - s.returned_total, 0);
  v.innerHTML = `<div class="head"><div><h1>Продажи</h1><p class="sub">${res.total} ${plural(res.total, 'чек', 'чека', 'чеков')}${SL.status === 'completed' && res.items.length ? `, на странице ${money(sum)} с учётом возвратов` : ''}</p></div>
    ${can('sales.create') ? '<a class="btn" href="#kassa">Новая продажа</a>' : ''}</div>
  <div class="panel"><div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
    ${segPeriods(SL.period)}
    <select class="input" id="slStatus" style="width:auto"><option value="completed" ${SL.status === 'completed' ? 'selected' : ''}>Проведённые</option><option value="held" ${SL.status === 'held' ? 'selected' : ''}>Отложенные</option><option value="cancelled" ${SL.status === 'cancelled' ? 'selected' : ''}>Отменённые</option></select>
    <input class="input" id="slNum" type="number" placeholder="№ чека" value="${esc(SL.num)}" style="width:130px" aria-label="Номер чека"></div>
    ${res.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>№</th><th>Дата</th><th>Клиент</th><th>Товары</th><th>Оплата</th><th class="r">Сумма</th></tr></thead><tbody>
      ${res.items.map(s => `<tr class="click" data-sale="${s.id}" tabindex="0"><td class="num">${s.number}</td><td>${fDateTime(s.created_at)}</td><td>${esc(cn[s.client_id] || (s.client_id ? 'Клиент' : '—'))}</td>
        <td>${esc(s.items.map(i => i.name).slice(0, 2).join(', '))}${s.items.length > 2 ? ` +${s.items.length - 2}` : ''}</td>
        <td>${s.payments.map(p => `<span class="tag ${PAY_TAG[p.method]}">${PAY[p.method]}</span>`).join(' ') || '<span class="tag grey">не оплачен</span>'}</td>
        <td class="r"><b>${money(s.total)}</b>${s.returned_total ? `<br><small class="bad">возврат ${num(s.returned_total)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${pager(res.total, SL.page, 50)}` : '<p class="empty">За выбранный период продаж нет.</p>'}</div>`;
  v.onclick = e => {
    const pb = e.target.closest('[data-period]'); if (pb) { SL.period = pb.dataset.period; SL.page = 1; route(); return; }
    const pg = e.target.closest('[data-page]'); if (pg) { SL.page = +pg.dataset.page; route(); return; }
    const tr = e.target.closest('[data-sale]'); if (tr) saleModal(res.items.find(s => s.id === +tr.dataset.sale), cn);
  };
  v.onkeydown = e => { const tr = e.target.closest('[data-sale]'); if (tr && e.key === 'Enter') tr.click(); };
  v.onchange = e => { if (e.target.id === 'slStatus') { SL.status = e.target.value; SL.page = 1; route(); } if (e.target.id === 'slNum') { SL.num = e.target.value; route(); } };
}
const pager = (total, page, size) => total <= size ? '' : `<div class="pager"><span>${(page - 1) * size + 1}–${Math.min(total, page * size)} из ${total}</span>
  <button class="btn ghost sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Назад</button><button class="btn ghost sm" data-page="${page + 1}" ${page * size >= total ? 'disabled' : ''}>Дальше</button></div>`;
async function saleModal(s, cn = {}) {
  const returns = s.status === 'completed' ? await api(`/api/sales/${s.id}/returns`) : [];
  const canRet = can('sales.return') && s.status === 'completed' && s.items.some(i => i.qty > i.returned_qty);
  const m = modal(`Чек №${s.number}`, `<p class="sub" style="margin-top:-8px">${fDateTime(s.created_at)}${s.client_id ? ` · ${esc(cn[s.client_id] || 'клиент')}` : ''}</p>
    <form class="form" id="retForm"><div class="tbl-wrap"><table><thead><tr><th>Товар</th><th class="r">Кол-во</th><th class="r">Цена</th><th class="r">Скидка</th><th class="r">Сумма</th>${canRet ? '<th class="r">Вернуть</th>' : ''}</tr></thead><tbody>
    ${s.items.map(i => `<tr><td>${esc(i.name)}${i.returned_qty ? `<br><small class="bad">возвращено ${num(i.returned_qty)}</small>` : ''}</td><td class="r">${num(i.qty)}</td><td class="r">${num(i.price)}</td><td class="r">${i.discount ? '−' + num(i.discount) : ''}</td><td class="r"><b>${num(i.total)}</b></td>
      ${canRet ? `<td class="r">${i.qty > i.returned_qty ? `<input class="input num" style="width:80px;min-height:36px" type="number" min="0" max="${i.qty - i.returned_qty}" step="1" name="r${i.id}" value="0" aria-label="Вернуть ${esc(i.name)}">` : ''}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>
    <div class="mono" style="display:grid;gap:4px;font-size:14px">
      ${s.discount ? `<div style="display:flex;justify-content:space-between"><span>Скидка</span><span>−${num(s.discount)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-weight:600"><span>Итого</span><span>${money(s.total)}</span></div>
      ${s.payments.map(p => `<div style="display:flex;justify-content:space-between" class="muted"><span>${PAY[p.method]}</span><span>${num(p.amount)}</span></div>`).join('')}
      ${s.bonus_earned ? `<div style="display:flex;justify-content:space-between" class="muted"><span>Начислено бонусов</span><span>${num(s.bonus_earned)}</span></div>` : ''}
      ${returns.map(r => `<div style="display:flex;justify-content:space-between" class="bad"><span>Возврат ${fDateTime(r.created_at)} (${PAY[r.refund_method] || r.refund_method})</span><span>−${num(r.amount)}</span></div>`).join('')}</div>
    ${canRet ? `<div class="two">${field('Как вернуть деньги', `<select class="input" name="refund_method"><option value="cash">Наличными</option><option value="card">На карту</option>${s.client_id ? '<option value="debt">Уменьшить долг клиента</option>' : ''}</select>`)}${field('Причина', inp('reason', { ph: 'Например, брак' }))}</div>
      <div class="err" hidden></div><div class="modal-f" style="margin-top:0"><button class="btn danger" type="submit">Оформить возврат</button></div>` : ''}</form>`, { wide: true });
  const f = $('#retForm', m.el);
  f.onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const items = s.items.map(i => ({ sale_item_id: i.id, qty: +(d['r' + i.id] || 0) })).filter(x => x.qty > 0);
    const err = $('.err', f);
    if (!items.length) { err.textContent = 'Укажите, сколько штук вернуть'; err.hidden = false; return; }
    try { const r = await api(`/api/sales/${s.id}/returns`, { method: 'POST', body: { items, refund_method: d.refund_method, reason: d.reason || null } }); m.close(); toast(`Возврат оформлен: ${money(r.amount)}`); route(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  };
}

// ================= ТОВАРЫ =================
const P = { status: 'all', q: '', page: 1, cat: '' };
async function viewProducts(v) {
  const [stats, res] = await Promise.all([
    api('/api/products/stats' + qs({ store_id: S.storeId })),
    api('/api/products' + qs({ status: P.status, q: P.q, category_id: P.cat, store_id: S.storeId, page: P.page, size: 50 })),
  ]);
  const tabs = [['all', 'Все', stats.all], ['active', 'Активные', stats.active], ['inactive', 'Неактивные', stats.inactive], ['low', 'Малый остаток', stats.low_stock], ['zero', 'Нулевой остаток', stats.zero_stock]];
  const cn = Object.fromEntries(S.cats.map(c => [c.id, c.name]));
  v.innerHTML = `<div class="head"><div><h1>Товары</h1><p class="sub">Остатки показаны для магазина «${esc(S.stores.find(s => s.id === S.storeId)?.name || '')}»</p></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${can('stock.manage') ? '<button class="btn ghost" data-a="stockin">Приход товара</button>' : ''}
      ${can('stock.manage') && can('products.write') ? '<button class="btn ghost" data-a="import">Импорт из CSV</button>' : ''}
      ${can('products.write') ? '<button class="btn" data-a="new">Новый товар</button>' : ''}</div></div>
  <div class="chips">${tabs.map(([k, t, n]) => `<button class="chip ${P.status === k ? 'on' : ''}" data-status="${k}">${t}<small>${n}</small></button>`).join('')}</div>
  <div class="panel"><div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
    <label class="search" style="flex:1 1 280px;min-height:44px"><input id="pq" placeholder="Название, артикул или штрихкод" value="${esc(P.q)}" aria-label="Поиск"></label>
    <select class="input" id="pcat" style="width:auto">${opts(S.cats, P.cat, 'id', 'name', 'Все категории')}</select></div>
    ${res.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Название</th><th>Артикул</th><th>Штрихкод</th><th>Категория</th><th class="r">Цена</th><th class="r">Себестоимость</th><th class="r">Остаток</th></tr></thead><tbody>
    ${res.items.map(p => { const st = stockOf(p); return `<tr class="click" data-p="${p.id}" tabindex="0"><td><b>${esc(p.name)}</b>${p.is_active ? '' : ' <span class="tag grey">выключен</span>'}</td><td>${esc(p.sku || '—')}</td><td>${esc(p.barcode || '—')}</td><td>${esc(cn[p.category_id] || '—')}</td>
      <td class="r">${money(p.retail_price)}</td><td class="r muted">${num(p.cost_price)}</td>
      <td class="r">${p.is_service ? '<span class="tag grey">услуга</span>' : `<span class="tag ${st <= 0 ? 'red' : st <= +S.company.low_stock_threshold ? 'amber' : 'green'}">${num(st)} ${esc(p.unit)}</span>`}</td></tr>`; }).join('')}
    </tbody></table></div>${pager(res.total, P.page, 50)}`
    : `<p class="empty">${stats.all ? 'По этому фильтру товаров нет.' : 'Каталог пустой. Добавьте первый товар или загрузите список из CSV.'}</p>`}</div>`;
  const reload = debounce(() => { P.page = 1; route(); }, 350);
  v.oninput = e => { if (e.target.id === 'pq') { P.q = e.target.value; reload(); } };
  v.onchange = e => { if (e.target.id === 'pcat') { P.cat = e.target.value; P.page = 1; route(); } };
  v.onkeydown = e => { const tr = e.target.closest('[data-p]'); if (tr && e.key === 'Enter') tr.click(); };
  v.onclick = e => {
    const t = e.target.closest('[data-status],[data-page],[data-p],[data-a]'); if (!t) return;
    if (t.dataset.status) { P.status = t.dataset.status; P.page = 1; route(); }
    else if (t.dataset.page) { P.page = +t.dataset.page; route(); }
    else if (t.dataset.p) productModal(res.items.find(p => p.id === +t.dataset.p));
    else if (t.dataset.a === 'new') productModal(null);
    else if (t.dataset.a === 'stockin') stockInModal();
    else if (t.dataset.a === 'import') importModal();
  };
}
async function ensureCategory(d) {
  if (d.new_category?.trim()) { const c = await api('/api/categories', { method: 'POST', body: { name: d.new_category.trim() } }); S.cats.push(c); return c.id; }
  return nOrNull(d.category_id);
}
async function productModal(p) {
  const isNew = !p, edit = can('products.write');
  const moves = p ? await api(`/api/products/${p.id}/movements` + qs({ store_id: S.storeId, limit: 15 })) : [];
  const REASON = { sale: 'Продажа', return: 'Возврат', import: 'Импорт', supplier_order: 'Приход', inventory: 'Инвентаризация', transfer_in: 'Перемещение (приход)', transfer_out: 'Перемещение (расход)', writeoff: 'Списание', manual: 'Вручную' };
  const fields = `
    ${field('Название', inp('name', { value: p?.name, req: true }))}
    <div class="two">${field('Артикул', inp('sku', { value: p?.sku || '' }))}${field('Штрихкод', inp('barcode', { value: p?.barcode || '' }))}</div>
    <div class="two">${field('Категория', `<select class="input" name="category_id">${opts(S.cats, p?.category_id, 'id', 'name', 'Без категории')}</select>`)}${field('Или новая категория', inp('new_category', { ph: 'Название новой категории' }))}</div>
    <div class="two">${field('Розничная цена', inp('retail_price', { type: 'number', step: '0.01', min: 0, value: p?.retail_price ?? '', req: true }))}${field('Себестоимость', inp('cost_price', { type: 'number', step: '0.01', min: 0, value: p?.cost_price ?? '' }))}</div>
    <div class="two">${field('Единица', inp('unit', { value: p?.unit || 'шт' }))}${isNew ? field('Начальный остаток', inp('qty', { type: 'number', step: '1', min: 0, ph: '0' })) : '<span></span>'}</div>
    <label class="check"><input type="checkbox" name="is_service" ${p?.is_service ? 'checked' : ''}> Это услуга (без остатка на складе)</label>
    ${!isNew ? `<label class="check"><input type="checkbox" name="is_active" ${p.is_active ? 'checked' : ''}> Продаётся (виден на кассе)</label>` : ''}
    ${!isNew ? `<p class="note" style="margin:0">Изменение розничной цены сохраняется как переоценка — с историей.</p>` : ''}`;
  const history = p ? `<h2 style="margin-top:20px;font-size:16px">Движение товара в этом магазине</h2>${moves.length ? `<div class="tbl-wrap"><table><tbody>${moves.map(mv => `<tr><td>${fDateTime(mv.created_at)}</td><td>${REASON[mv.reason] || mv.reason}</td><td class="r ${mv.delta < 0 ? 'bad' : 'good'}">${mv.delta > 0 ? '+' : ''}${num(mv.delta)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Движений пока не было.</p>'}` : '';
  if (!edit) { modal(p.name, `<p>Цена: <b>${money(p.retail_price)}</b>. Остаток: <b>${num(stockOf(p))} ${esc(p.unit)}</b></p>${history}`, { wide: true }); return; }
  formModal(isNew ? 'Новый товар' : p.name, fields, async (d, m) => {
    const category_id = await ensureCategory(d);
    const base = { name: d.name, sku: d.sku || null, barcode: d.barcode || null, category_id, unit: d.unit || 'шт', is_service: !!d.is_service, cost_price: nOrNull(d.cost_price) ?? 0 };
    if (isNew) {
      const np = await api('/api/products', { method: 'POST', body: { ...base, retail_price: nOrNull(d.retail_price) ?? 0 } });
      const q = nOrNull(d.qty);
      if (q > 0 && !np.is_service && can('stock.manage')) {
        const doc = await api('/api/stock/supplier_order', { method: 'POST', body: { store_id: S.storeId, items: [{ product_id: np.id, qty: q, price: base.cost_price }] } });
        await api(`/api/stock/supplier_order/${doc.id}/complete`, { method: 'POST' });
      }
      toast(`Товар «${np.name}» добавлен`);
    } else {
      await api(`/api/products/${p.id}`, { method: 'PATCH', body: { ...base, is_active: !!d.is_active } });
      const price = nOrNull(d.retail_price);
      if (price != null && price !== p.retail_price) {
        if (!can('stock.manage')) throw new Error('Менять цену может сотрудник с правом на складские документы');
        const doc = await api('/api/stock/repricing', { method: 'POST', body: { items: [{ product_id: p.id, price }] } });
        await api(`/api/stock/repricing/${doc.id}/complete`, { method: 'POST' });
      }
      toast('Изменения сохранены');
    }
    m.close(); route();
  }, { wide: true, extra: history, submit: isNew ? 'Добавить товар' : 'Сохранить' });
}
async function stockInModal() {
  const [all, sups] = await Promise.all([api('/api/products' + qs({ status: 'active', size: 500, store_id: S.storeId })), api('/api/suppliers')]);
  const goods = all.items.filter(p => !p.is_service);
  if (!goods.length) { toast('Сначала добавьте товары в каталог', true); return; }
  const row = () => `<div class="two srow" style="grid-template-columns:minmax(0,3fr) minmax(0,1fr) minmax(0,1fr) auto;align-items:end">
    ${field('Товар', `<select class="input" name="pid">${opts(goods, '', 'id', 'name', 'Выберите товар')}</select>`)}${field('Кол-во', '<input class="input" name="qty" type="number" min="1" step="1">')}${field('Закупка за шт.', '<input class="input" name="cost" type="number" min="0" step="0.01">')}<button type="button" class="x" data-del aria-label="Убрать строку">×</button></div>`;
  const m = formModal('Приход товара', `
    <div class="two">${field('Поставщик', `<select class="input" name="supplier_id">${opts(sups, '', 'id', 'name', 'Не указан')}</select>`)}${field('Или новый поставщик', inp('new_supplier', { ph: 'Название' }))}</div>
    <div id="rows" style="display:grid;gap:10px">${row()}${row()}</div><button type="button" class="btn ghost sm" data-addrow style="justify-self:start">+ Ещё товар</button>
    <p class="note" style="margin:0">Товар сразу поступит на склад магазина «${esc(S.stores.find(s => s.id === S.storeId)?.name || '')}», закупочная цена обновится.</p>`,
  async (d, mm, f) => {
    const items = $$('.srow', f).map(r => ({ product_id: nOrNull($('[name=pid]', r).value), qty: nOrNull($('[name=qty]', r).value), price: nOrNull($('[name=cost]', r).value) })).filter(x => x.product_id && x.qty > 0);
    if (!items.length) throw new Error('Добавьте хотя бы один товар с количеством');
    let supplier_id = nOrNull(d.supplier_id);
    if (d.new_supplier?.trim()) supplier_id = (await api('/api/suppliers', { method: 'POST', body: { name: d.new_supplier.trim() } })).id;
    const doc = await api('/api/stock/supplier_order', { method: 'POST', body: { store_id: S.storeId, supplier_id, items } });
    await api(`/api/stock/supplier_order/${doc.id}/complete`, { method: 'POST' });
    mm.close(); toast(`Приход проведён: ${items.length} ${plural(items.length, 'позиция', 'позиции', 'позиций')}`); route();
  }, { wide: true, submit: 'Провести приход' });
  m.el.addEventListener('click', e => {
    if (e.target.closest('[data-addrow]')) $('#rows', m.el).insertAdjacentHTML('beforeend', row());
    const del = e.target.closest('[data-del]'); if (del && $$('.srow', m.el).length > 1) del.closest('.srow').remove();
  });
}
function importModal() {
  formModal('Импорт товаров из CSV', `<p class="sub" style="margin:0">Файл CSV (Excel → «Сохранить как CSV») с колонками: <b>name</b>, sku, barcode, category, supplier, cost_price, retail_price, qty. Товары с тем же артикулом обновятся, количество добавится к остатку магазина.</p>
    ${field('Файл', '<input class="input" type="file" name="file" accept=".csv,text/csv" required style="padding-top:9px">')}`,
  async (d, m, f) => {
    const file = $('[name=file]', f).files[0]; if (!file) throw new Error('Выберите файл');
    const fd = new FormData(); fd.append('file', file);
    const r = await api('/api/products/import' + qs({ store_id: S.storeId }), { method: 'POST', form: fd });
    S.cats = await api('/api/categories');
    m.body.innerHTML = `<div class="ok-msg">Создано товаров: ${r.created}, обновлено: ${r.updated}</div>${r.errors.length ? `<div class="err" style="margin-top:10px">Пропущено строк: ${r.errors.length}<br>${r.errors.slice(0, 10).map(esc).join('<br>')}</div>` : ''}<div class="modal-f"><button class="btn" data-close>Готово</button></div>`;
    route();
  }, { submit: 'Загрузить' });
}

// ================= КЛИЕНТЫ =================
const C = { q: '', debt: false, page: 1 };
async function viewClients(v) {
  const [res, sum, groups] = await Promise.all([
    api('/api/clients' + qs({ q: C.q, has_debt: C.debt, page: C.page, size: 50 })), api('/api/clients/debts/summary'), api('/api/client-groups')]);
  const gn = Object.fromEntries(groups.map(g => [g.id, g.name]));
  v.innerHTML = `<div class="head"><div><h1>Клиенты</h1><p class="sub">${sum.debtors ? `${sum.debtors} ${plural(sum.debtors, 'клиент должен', 'клиента должны', 'клиентов должны')} в сумме <b class="bad">${money(sum.total_debt)}</b>` : 'Долгов нет'}</p></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${can('marketing.manage') ? '<button class="btn ghost" data-a="groups">Группы и скидки</button>' : ''}${can('clients.write') ? '<button class="btn" data-a="new">Новый клиент</button>' : ''}</div></div>
  <div class="panel"><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px">
    <label class="search" style="flex:1 1 280px;min-height:44px"><input id="cq" placeholder="Имя или телефон" value="${esc(C.q)}" aria-label="Поиск клиента"></label>
    <label class="check"><input type="checkbox" id="cdebt" ${C.debt ? 'checked' : ''}> Только должники</label></div>
    ${res.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Имя</th><th>Телефон</th><th>Группа</th><th class="r">Бонусы</th><th class="r">Долг</th></tr></thead><tbody>
    ${res.items.map(c => `<tr class="click" data-c="${c.id}" tabindex="0"><td><b>${esc(c.name)}</b> ${(c.tags || []).map(t => `<span class="tag grey">${esc(t)}</span>`).join(' ')}</td><td>${esc(c.phone || '—')}</td><td>${esc(gn[c.group_id] || '—')}</td>
      <td class="r">${num(c.bonus_balance)}</td><td class="r">${+c.debt_balance ? `<b class="bad">${money(c.debt_balance)}</b>` : '—'}</td></tr>`).join('')}</tbody></table></div>${pager(res.total, C.page, 50)}`
    : `<p class="empty">${C.q || C.debt ? 'Никого не нашли.' : 'Клиентов пока нет. Добавьте клиента здесь или прямо на кассе.'}</p>`}</div>`;
  const reload = debounce(() => { C.page = 1; route(); }, 350);
  v.oninput = e => { if (e.target.id === 'cq') { C.q = e.target.value; reload(); } };
  v.onchange = e => { if (e.target.id === 'cdebt') { C.debt = e.target.checked; C.page = 1; route(); } };
  v.onkeydown = e => { const tr = e.target.closest('[data-c]'); if (tr && e.key === 'Enter') tr.click(); };
  v.onclick = e => {
    const t = e.target.closest('[data-c],[data-a],[data-page]'); if (!t) return;
    if (t.dataset.c) clientCard(res.items.find(c => c.id === +t.dataset.c), groups);
    else if (t.dataset.page) { C.page = +t.dataset.page; route(); }
    else if (t.dataset.a === 'new') clientModal(null, () => route());
    else if (t.dataset.a === 'groups') groupsModal(groups);
  };
}
async function clientModal(c, done, preset = {}) {
  const groups = await api('/api/client-groups').catch(() => []);
  formModal(c ? 'Изменить клиента' : 'Новый клиент', `
    ${field('Имя', inp('name', { value: c?.name ?? preset.name ?? '', req: true }))}
    <div class="two">${field('Телефон', inp('phone', { type: 'tel', value: c?.phone || '', ph: '+998 90 123 45 67' }))}${field('Дата рождения', inp('birth_date', { type: 'date', value: c?.birth_date || '' }))}</div>
    <div class="two">${field('Группа', `<select class="input" name="group_id">${opts(groups.map(g => ({ ...g, name: `${g.name}${+g.discount_percent ? ` (−${num(g.discount_percent)}%)` : ''}` })), c?.group_id, 'id', 'name', 'Без группы')}</select>`)}${field('Теги через запятую', inp('tags', { value: (c?.tags || []).join(', '), ph: 'опт, постоянный' }))}</div>
    ${field('Заметка', `<textarea class="input" name="note">${esc(c?.note || '')}</textarea>`)}
    <label class="check"><input type="checkbox" name="sms_allowed" ${c?.sms_allowed ?? true ? 'checked' : ''}> Согласен получать SMS</label>`,
  async (d, m) => {
    const body = { name: d.name, phone: d.phone || null, birth_date: d.birth_date || null, group_id: nOrNull(d.group_id), note: d.note || null,
      tags: d.tags.split(',').map(s => s.trim()).filter(Boolean), sms_allowed: !!d.sms_allowed };
    const r = c ? await api(`/api/clients/${c.id}`, { method: 'PATCH', body }) : await api('/api/clients', { method: 'POST', body });
    m.close(); toast(c ? 'Клиент сохранён' : `Клиент «${r.name}» добавлен`); done?.(r);
  }, { submit: c ? 'Сохранить' : 'Добавить клиента' });
}
async function clientCard(c, groups) {
  const [sales, pays] = await Promise.all([api(`/api/clients/${c.id}/sales`), api(`/api/clients/${c.id}/debt-payments`)]);
  const total = sales.reduce((a, s) => a + s.total - s.returned_total, 0);
  const m = modal(c.name, `<div class="kpis" style="margin-bottom:16px">
      <div class="kpi" style="background:var(--bg)"><span>Покупок</span><b>${sales.length}</b><small class="muted">на ${money(total)}</small></div>
      <div class="kpi" style="background:var(--bg)"><span>Бонусы</span><b>${num(c.bonus_balance)}</b></div>
      <div class="kpi" style="background:var(--bg)"><span>Долг</span><b class="${+c.debt_balance ? 'bad' : ''}">${money(c.debt_balance)}</b></div></div>
    <p class="sub" style="margin:0 0 12px">${esc(c.phone || 'Телефон не указан')}${c.group_id ? ` · ${esc(groups.find(g => g.id === c.group_id)?.name || '')}` : ''}${c.note ? `<br>${esc(c.note)}` : ''}</p>
    ${+c.debt_balance && can('clients.write') ? `<form class="form panel" id="payDebt" style="background:var(--bg);margin-bottom:16px"><h2 style="font-size:16px">Принять оплату долга</h2>
      <div class="two">${field('Сумма', inp('amount', { type: 'number', step: '0.01', min: 0, value: c.debt_balance, req: true }))}${field('Способ', '<select class="input" name="method"><option value="cash">Наличные</option><option value="card">Карта</option></select>')}</div>
      <div class="err" hidden></div><button class="btn" type="submit">Принять оплату</button></form>` : ''}
    <h2 style="font-size:16px">Последние покупки</h2>${sales.length ? `<div class="tbl-wrap"><table><tbody>${sales.slice(0, 10).map(s => `<tr><td>№${s.number}</td><td>${fDateTime(s.created_at)}</td><td>${s.payments.map(p => `<span class="tag ${PAY_TAG[p.method]}">${PAY[p.method]}</span>`).join(' ')}</td><td class="r"><b>${money(s.total)}</b></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Покупок пока нет.</p>'}
    ${pays.length ? `<h2 style="font-size:16px;margin-top:16px">Оплаты долга</h2><div class="tbl-wrap"><table><tbody>${pays.slice(0, 10).map(p => `<tr><td>${fDateTime(p.created_at)}</td><td>${PAY[p.method]}</td><td class="r good">${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="modal-f">${can('clients.write') ? '<button class="btn ghost" data-edit>Изменить</button>' : ''}<button class="btn" data-close>Закрыть</button></div>`, { wide: true });
  $('[data-edit]', m.el)?.addEventListener('click', () => { m.close(); clientModal(c, () => route()); });
  const f = $('#payDebt', m.el);
  if (f) f.onsubmit = async e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    try { await api(`/api/clients/${c.id}/debt-payments`, { method: 'POST', body: { amount: nOrNull(d.amount), method: d.method, store_id: S.storeId } }); m.close(); toast(`Оплата долга принята: ${money(d.amount)}`); route(); }
    catch (x) { const err = $('.err', f); err.textContent = x.message; err.hidden = false; }
  };
}
function groupsModal(groups) {
  const m = modal('Группы клиентов', `<p class="sub" style="margin-top:-6px">Скидка группы применяется на кассе автоматически, если выбран клиент из этой группы.</p>
    ${groups.length ? `<div class="tbl-wrap"><table><tbody>${groups.map(g => `<tr><td><b>${esc(g.name)}</b></td><td class="r">−${num(g.discount_percent)}%</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Групп пока нет.</p>'}
    <form class="form" style="margin-top:14px"><div class="two">${field('Новая группа', inp('name', { req: true, ph: 'Например, VIP' }))}${field('Скидка, %', inp('discount_percent', { type: 'number', min: 0, step: '0.1', value: 0 }))}</div>
    <div class="err" hidden></div><button class="btn" type="submit">Добавить группу</button></form>`);
  const f = $('form', m.el);
  f.onsubmit = async e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    try { await api('/api/client-groups', { method: 'POST', body: { name: d.name, discount_percent: nOrNull(d.discount_percent) || 0 } }); m.close(); toast('Группа добавлена'); route(); }
    catch (x) { const err = $('.err', f); err.textContent = x.message; err.hidden = false; }
  };
}

// ================= МАРКЕТИНГ =================
async function viewMarketing(v) {
  const [promos, codes, sms, groups] = await Promise.all([api('/api/marketing/promotions'), api('/api/marketing/promo-codes'), api('/api/marketing/sms'), api('/api/client-groups')]);
  const cn = Object.fromEntries(S.cats.map(c => [c.id, c.name]));
  const active = p => p.is_active && (!p.ends_at || utc(p.ends_at) >= new Date()) && (!p.starts_at || utc(p.starts_at) <= new Date());
  v.innerHTML = `<div class="head"><div><h1>Маркетинг</h1><p class="sub">Акции и промокоды срабатывают на кассе автоматически</p></div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))">
    <section class="panel"><div class="head" style="margin-bottom:12px"><h2>Акции</h2><button class="btn sm" data-a="promo">Новая акция</button></div>
      ${promos.length ? `<div class="tbl-wrap"><table><tbody>${promos.map(p => `<tr><td><b>${esc(p.name)}</b><br><small class="muted">${p.category_ids.length ? esc(p.category_ids.map(i => cn[i]).filter(Boolean).join(', ')) : p.product_ids.length ? `${p.product_ids.length} товаров` : 'Все товары'}${p.ends_at ? ` · до ${fDateTime(p.ends_at)}` : ''}</small></td>
        <td class="r"><b>−${num(p.discount_percent)}%</b></td><td class="r"><span class="tag ${active(p) ? 'green' : 'grey'}">${active(p) ? 'идёт' : 'не активна'}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Акций нет. Например: −15% на категорию «Уход» до конца месяца.</p>'}</section>
    <section class="panel"><div class="head" style="margin-bottom:12px"><h2>Промокоды</h2><button class="btn sm" data-a="code">Новый промокод</button></div>
      ${codes.length ? `<div class="tbl-wrap"><table><tbody>${codes.map(c => `<tr><td><b class="mono">${esc(c.code)}</b><br><small class="muted">${c.discount_percent ? `−${num(c.discount_percent)}%` : `−${money(c.discount_amount)}`}${+c.min_total ? ` от ${num(c.min_total)}` : ''}${c.expires_at ? ` · до ${fDateTime(c.expires_at)}` : ''}</small></td>
        <td class="r">${c.used_count}${c.max_uses ? ` из ${c.max_uses}` : ''} исп.</td><td class="r"><button class="btn link sm" data-toggle="${c.id}" data-on="${c.is_active ? 0 : 1}">${c.is_active ? 'Выключить' : 'Включить'}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Промокодов нет.</p>'}</section>
  </div>
  <section class="panel"><h2>SMS-рассылка</h2>
    <form class="form" id="smsF" style="margin-bottom:14px">${field('Текст сообщения', '<textarea class="input" name="text" maxlength="1000" required placeholder="Например: Скидка 10% на всё в эти выходные!"></textarea>')}
      <div class="two">${field('Кому', `<select class="input" name="group_id">${opts(groups, '', 'id', 'name', 'Всем клиентам с согласием')}</select>`)}${field('Только с тегом', inp('tag', { ph: 'необязательно' }))}</div>
      <div class="err" hidden></div><button class="btn" type="submit" style="justify-self:start">Отправить рассылку</button>
      <p class="note" style="margin:0">Сейчас SMS записываются в журнал сервера. Чтобы они уходили на телефоны, подключите SMS-провайдера (Eskiz, Play Mobile).</p></form>
    ${sms.length ? `<div class="tbl-wrap"><table><thead><tr><th>Дата</th><th>Текст</th><th class="r">Получателей</th><th class="r">Статус</th></tr></thead><tbody>${sms.slice(0, 20).map(s => `<tr><td>${fDateTime(s.created_at)}</td><td>${esc(s.text)}</td><td class="r">${s.recipients.length}</td><td class="r"><span class="tag ${s.status === 'sent' ? 'green' : s.status === 'failed' ? 'red' : 'grey'}">${{ sent: 'отправлено', failed: 'ошибка', queued: 'в очереди' }[s.status] || s.status}</span></td></tr>`).join('')}</tbody></table></div>` : ''}</section>`;
  v.onclick = async e => {
    const t = e.target.closest('[data-a],[data-toggle]'); if (!t) return;
    if (t.dataset.a === 'promo') formModal('Новая акция', `${field('Название', inp('name', { req: true, ph: 'Неделя укладки' }))}${field('Скидка, %', inp('discount_percent', { type: 'number', min: 1, max: 100, step: '0.1', req: true }))}
      <div class="field"><span>Категории (если не выбрать — на все товары)</span><div class="chips">${S.cats.map(c => `<label class="check" style="min-height:32px"><input type="checkbox" name="cat" value="${c.id}"> ${esc(c.name)}</label>`).join('') || '<span class="muted">Категорий нет</span>'}</div></div>
      <div class="two">${field('Начало', inp('starts_at', { type: 'datetime-local' }))}${field('Конец', inp('ends_at', { type: 'datetime-local' }))}</div>`,
    async (d, m, f) => {
      const toIso = s => s ? new Date(s).toISOString().slice(0, 19) : null;
      await api('/api/marketing/promotions', { method: 'POST', body: { name: d.name, discount_percent: nOrNull(d.discount_percent), category_ids: $$('[name=cat]:checked', f).map(x => +x.value), starts_at: toIso(d.starts_at), ends_at: toIso(d.ends_at) } });
      m.close(); toast('Акция создана'); route();
    }, { submit: 'Создать акцию' });
    if (t.dataset.a === 'code') formModal('Новый промокод', `${field('Код', inp('code', { req: true, ph: 'WEEKEND10', attrs: 'style="text-transform:uppercase"' }))}
      <div class="two">${field('Скидка, %', inp('discount_percent', { type: 'number', min: 0, max: 100, step: '0.1', ph: 'или сумма →' }))}${field('Скидка суммой', inp('discount_amount', { type: 'number', min: 0, step: '0.01' }))}</div>
      <div class="two">${field('От суммы чека', inp('min_total', { type: 'number', min: 0, step: '0.01', value: 0 }))}${field('Сколько раз можно использовать', inp('max_uses', { type: 'number', min: 1, step: 1, ph: 'без ограничений' }))}</div>
      ${field('Действует до', inp('expires_at', { type: 'datetime-local' }))}`,
    async (d, m) => {
      await api('/api/marketing/promo-codes', { method: 'POST', body: { code: d.code, discount_percent: nOrNull(d.discount_percent) || null, discount_amount: nOrNull(d.discount_amount) || null, min_total: nOrNull(d.min_total) || 0, max_uses: nOrNull(d.max_uses), expires_at: d.expires_at ? new Date(d.expires_at).toISOString().slice(0, 19) : null } });
      m.close(); toast('Промокод создан'); route();
    }, { submit: 'Создать промокод' });
    if (t.dataset.toggle) { try { await api(`/api/marketing/promo-codes/${t.dataset.toggle}/active?is_active=${t.dataset.on === '1'}`, { method: 'PATCH' }); route(); } catch (x) { toast(x.message, true); } }
  };
  $('#smsF').onsubmit = async e => {
    e.preventDefault(); const f = e.target, d = Object.fromEntries(new FormData(f)), err = $('.err', f);
    try { const r = await api('/api/marketing/sms', { method: 'POST', body: { text: d.text, group_id: nOrNull(d.group_id), tag: d.tag || null } }); toast(`Рассылка создана: ${r.recipients.length} получателей`); route(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  };
}

// ================= ОТЧЁТЫ =================
const R = { period: 'month', tab: 'products' };
async function viewReports(v) {
  const r = periodRange(R.period), q = { date_from: r.from, date_to: r.to };
  const tabs = { products: 'По товарам', sellers: 'По продавцам', stores: 'По магазинам', clients: 'По клиентам', marketing: 'Скидки и бонусы' };
  if (R.tab === 'clients' && !can('clients.read')) R.tab = 'products';
  const data = await api(`/api/reports/${R.tab}` + qs(q));
  let head = [], rows = [], extra = '';
  if (R.tab === 'products') { head = ['Товар', 'Продано', 'Выручка', 'Прибыль', 'Маржа']; rows = data.map(x => [x.name, num(x.qty), money(x.net), money(x.profit), x.margin_percent + '%']); }
  if (R.tab === 'sellers') { head = ['Продавец', 'Чеков', 'Товаров', 'Выручка', 'Средний чек']; rows = data.map(x => [x.name, x.checks, num(x.items), money(x.net), money(x.average_check)]); }
  if (R.tab === 'stores') { head = ['Магазин', 'Чеков', 'Выручка', 'Прибыль', 'Средний чек']; rows = data.map(x => [x.name, x.checks, money(x.net), money(x.profit), money(x.average_check)]); }
  if (R.tab === 'clients') { head = ['Клиент', 'Телефон', 'Чеков', 'Выручка', 'Долг', 'Последняя покупка']; rows = data.clients.map(x => [x.name, x.phone || '—', x.checks, money(x.net), x.debt ? money(x.debt) : '—', fDateTime(x.last_purchase)]);
    extra = `<p class="note">Без клиента: ${data.without_client.checks} ${plural(data.without_client.checks, 'чек', 'чека', 'чеков')} на ${money(data.without_client.net)}</p>`; }
  if (R.tab === 'marketing') { head = ['Промокод', 'Использований', 'Выручка', 'Скидка']; rows = data.promo_codes.map(x => [x.code, x.uses, money(x.revenue), money(x.discount)]);
    extra = `<div class="kpis" style="margin-bottom:14px"><div class="kpi" style="background:var(--bg)"><span>Всего скидок</span><b>${money(data.total_discount)}</b><small class="muted">${data.checks_with_discount} из ${data.checks_total} чеков со скидкой</small></div>
      <div class="kpi" style="background:var(--bg)"><span>Начислено бонусов</span><b>${num(data.bonus_earned)}</b></div><div class="kpi" style="background:var(--bg)"><span>Оплачено бонусами</span><b>${num(data.bonus_paid)}</b></div></div>`; }
  v.innerHTML = `<div class="head"><div><h1>Отчёты</h1><p class="sub">${fDay(r.from)} — ${fDay(r.to)}. Выручка — с учётом скидок и возвратов, прибыль — минус себестоимость</p></div>${segPeriods(R.period, ['week', 'month', 'quarter', 'year'])}</div>
    <div class="chips">${Object.entries(tabs).filter(([k]) => k !== 'clients' || can('clients.read')).map(([k, t]) => `<button class="chip ${R.tab === k ? 'on' : ''}" data-tab="${k}">${t}</button>`).join('')}</div>
    <section class="panel">${R.tab === 'marketing' ? extra : ''}
      ${rows.length ? `<div class="tbl-wrap"><table><thead><tr>${head.map((h, i) => `<th class="${i ? 'r' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(rw => `<tr>${rw.map((c, i) => `<td class="${i ? 'r' : ''}">${i ? esc(c) : `<b>${esc(c)}</b>`}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <div class="modal-f"><button class="btn ghost sm" data-csv>Скачать CSV</button></div>` : '<p class="empty">За выбранный период данных нет.</p>'}
      ${R.tab === 'clients' ? extra : ''}</section>`;
  v.onclick = e => {
    const pb = e.target.closest('[data-period]'); if (pb) { R.period = pb.dataset.period; route(); return; }
    const tb = e.target.closest('[data-tab]'); if (tb) { R.tab = tb.dataset.tab; route(); return; }
    if (e.target.closest('[data-csv]')) {
      const csv = [head, ...rows].map(rw => rw.map(c => `"${String(c).replace(/\u00a0|\u202f/g, ' ').replace(/"/g, '""')}"`).join(';')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
      a.download = `tarozi-${R.tab}-${r.from}_${r.to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  };
}

// ================= СОТРУДНИКИ =================
async function viewStaff(v) {
  const [users, roles, perms] = await Promise.all([api('/api/users'), api('/api/roles'), api('/api/permissions')]);
  const rn = Object.fromEntries(roles.map(r => [r.id, r.name])), sn = Object.fromEntries(S.stores.map(s => [s.id, s.name]));
  v.innerHTML = `<div class="head"><div><h1>Сотрудники</h1><p class="sub">Каждый входит под своим логином и видит только то, что разрешено его роли</p></div><button class="btn" data-a="user">Новый сотрудник</button></div>
  <section class="panel"><div class="tbl-wrap"><table><thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Магазины</th><th class="r">Статус</th></tr></thead><tbody>
    ${users.map(u => `<tr class="click" data-u="${u.id}" tabindex="0"><td><b>${esc(u.name)}</b></td><td class="mono">${esc(u.login)}</td><td>${u.is_owner ? 'Владелец' : esc(rn[u.role_id] || '—')}</td><td>${u.is_owner || !u.store_ids.length ? 'Все' : esc(u.store_ids.map(i => sn[i]).join(', '))}</td><td class="r"><span class="tag ${u.is_active ? 'green' : 'grey'}">${u.is_active ? 'работает' : 'отключён'}</span></td></tr>`).join('')}</tbody></table></div></section>
  <section class="panel"><div class="head" style="margin-bottom:12px"><h2>Роли и права</h2><button class="btn ghost sm" data-a="role">Новая роль</button></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">${roles.map(r => `<button class="tile" style="cursor:pointer" data-role="${r.id}"><b>${esc(r.name)}</b><span class="note">${r.permissions.length} из ${perms.length} прав: ${esc(r.permissions.map(p => perms.find(x => x.key === p)?.title).filter(Boolean).slice(0, 3).join(', '))}${r.permissions.length > 3 ? '…' : ''}</span></button>`).join('')}</div></section>`;
  const userModal = u => formModal(u ? u.name : 'Новый сотрудник', `
    ${field('Имя', inp('name', { value: u?.name || '', req: true }))}
    <div class="two">${u ? '' : field('Логин', inp('login', { req: true, attrs: 'autocapitalize="none" autocomplete="off"' }))}${field(u ? 'Новый пароль' : 'Пароль', inp('password', { type: 'password', req: !u, ph: u ? 'Оставьте пустым, чтобы не менять' : 'Не меньше 8 символов', attrs: 'autocomplete="new-password"' }))}</div>
    ${u?.is_owner ? '' : field('Роль', `<select class="input" name="role_id">${opts(roles, u?.role_id ?? roles[0]?.id)}</select>`)}
    ${!u?.is_owner && S.stores.length > 1 ? `<div class="field"><span>Магазины (если не выбрать — все)</span><div class="chips">${S.stores.map(s => `<label class="check"><input type="checkbox" name="st" value="${s.id}" ${u?.store_ids.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div></div>` : ''}
    ${u && !u.is_owner ? `<label class="check"><input type="checkbox" name="is_active" ${u.is_active ? 'checked' : ''}> Может входить в систему</label>` : ''}`,
  async (d, m, f) => {
    const store_ids = $$('[name=st]:checked', f).map(x => +x.value);
    if (u) {
      const body = { name: d.name }; if (d.password) body.password = d.password;
      if (!u.is_owner) Object.assign(body, { role_id: nOrNull(d.role_id), store_ids, is_active: !!d.is_active });
      await api(`/api/users/${u.id}`, { method: 'PATCH', body });
    } else await api('/api/users', { method: 'POST', body: { name: d.name, login: d.login, password: d.password, role_id: nOrNull(d.role_id), store_ids } });
    m.close(); toast(u ? 'Сохранено' : `Сотрудник добавлен. Логин: ${d.login}`); route();
  }, { submit: u ? 'Сохранить' : 'Добавить' });
  const roleModal = r => formModal(r ? r.name : 'Новая роль', `${field('Название', inp('name', { value: r?.name || '', req: true }))}
    <div class="field"><span>Что может делать</span>${perms.map(p => `<label class="check"><input type="checkbox" name="perm" value="${p.key}" ${r?.permissions.includes(p.key) ? 'checked' : ''}> ${esc(p.title)}</label>`).join('')}</div>`,
  async (d, m, f) => {
    const body = { name: d.name, permissions: $$('[name=perm]:checked', f).map(x => x.value) };
    await api(r ? `/api/roles/${r.id}` : '/api/roles', { method: r ? 'PUT' : 'POST', body }); m.close(); toast('Роль сохранена'); route();
  });
  v.onclick = e => {
    const t = e.target.closest('[data-u],[data-a],[data-role]'); if (!t) return;
    if (t.dataset.u) userModal(users.find(u => u.id === +t.dataset.u));
    if (t.dataset.a === 'user') userModal(null);
    if (t.dataset.a === 'role') roleModal(null);
    if (t.dataset.role) roleModal(roles.find(r => r.id === +t.dataset.role));
  };
  v.onkeydown = e => { const tr = e.target.closest('[data-u]'); if (tr && e.key === 'Enter') tr.click(); };
}

// ================= НАСТРОЙКИ =================
async function viewSettings(v) {
  const [company, stores, targets] = await Promise.all([api('/api/company'), api('/api/stores'), api('/api/targets')]);
  const sn = Object.fromEntries(stores.map(s => [s.id, s.name]));
  v.innerHTML = `<div class="head"><div><h1>Настройки</h1><p class="sub">Компания, магазины и цели по выручке</p></div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))">
  <section class="panel"><h2>Компания</h2><form class="form" id="compF">
    ${field('Название', inp('name', { value: company.name, req: true }))}
    <div class="two">${field('Валюта', inp('currency', { value: company.currency, req: true }))}${field('Часовой пояс (UTC+, часов)', inp('tz', { type: 'number', step: '0.5', value: company.utc_offset_minutes / 60 }))}</div>
    <div class="two">${field('Бонусы с покупки, %', inp('loyalty_percent', { type: 'number', min: 0, step: '0.1', value: company.loyalty_percent }))}${field('Оплата бонусами, до % чека', inp('max_bonus_payment_percent', { type: 'number', min: 0, max: 100, step: 1, value: company.max_bonus_payment_percent }))}</div>
    ${field('Малый остаток — когда штук не больше', inp('low_stock_threshold', { type: 'number', min: 0, step: 1, value: company.low_stock_threshold }))}
    <label class="check"><input type="checkbox" name="allow_negative_stock" ${company.allow_negative_stock ? 'checked' : ''}> Разрешить продавать товар, которого нет на складе</label>
    <div class="err" hidden></div><button class="btn" type="submit" style="justify-self:start">Сохранить</button></form></section>
  <div class="grid" style="align-content:start">
  <section class="panel"><div class="head" style="margin-bottom:8px"><h2>Магазины</h2><button class="btn ghost sm" data-a="store">Добавить магазин</button></div>
    <div class="tbl-wrap"><table><tbody>${stores.map(s => `<tr class="click" data-s="${s.id}" tabindex="0"><td><b>${esc(s.name)}</b><br><small class="muted">${esc(s.address || 'адрес не указан')}</small></td><td class="r"><span class="tag ${s.is_active ? 'green' : 'grey'}">${s.is_active ? 'работает' : 'закрыт'}</span></td></tr>`).join('')}</tbody></table></div></section>
  <section class="panel"><div class="head" style="margin-bottom:8px"><h2>Цели по выручке</h2><button class="btn ghost sm" data-a="target">Новая цель</button></div>
    ${targets.length ? `<div class="tbl-wrap"><table><tbody>${targets.map(t => `<tr><td>${fDay(t.period_start)} — ${fDay(t.period_end)}<br><small class="muted">${esc(t.store_id ? sn[t.store_id] : 'Все магазины')}</small></td><td class="r"><b>${money(t.amount)}</b></td><td class="r"><button class="btn link sm" data-deltarget="${t.id}">Удалить</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Целей пока нет.</p>'}</section>
  </div></div>`;
  $('#compF').onsubmit = async e => {
    e.preventDefault(); const f = e.target, d = Object.fromEntries(new FormData(f)), err = $('.err', f);
    try {
      S.company = await api('/api/company', { method: 'PATCH', body: { name: d.name, currency: d.currency.trim(), utc_offset_minutes: Math.round((nOrNull(d.tz) || 0) * 60),
        loyalty_percent: nOrNull(d.loyalty_percent) || 0, max_bonus_payment_percent: nOrNull(d.max_bonus_payment_percent) || 0, low_stock_threshold: nOrNull(d.low_stock_threshold) || 0, allow_negative_stock: !!d.allow_negative_stock } });
      err.hidden = true; toast('Настройки сохранены'); renderShell(); route();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  };
  const storeModal = s => formModal(s ? s.name : 'Новый магазин', `${field('Название', inp('name', { value: s?.name || '', req: true }))}${field('Адрес', inp('address', { value: s?.address || '' }))}
    <label class="check"><input type="checkbox" name="is_active" ${s?.is_active ?? true ? 'checked' : ''}> Работает</label>`,
  async (d, m) => {
    await api(s ? `/api/stores/${s.id}` : '/api/stores', { method: s ? 'PUT' : 'POST', body: { name: d.name, address: d.address || null, is_active: !!d.is_active } });
    S.stores = (await api('/api/stores')).filter(x => x.is_active); m.close(); toast('Магазин сохранён'); renderShell(); route();
  });
  v.onclick = async e => {
    const t = e.target.closest('[data-a],[data-s],[data-deltarget]'); if (!t) return;
    if (t.dataset.a === 'store') storeModal(null);
    if (t.dataset.s) storeModal(stores.find(s => s.id === +t.dataset.s));
    if (t.dataset.a === 'target') targetModal();
    if (t.dataset.deltarget) { await api(`/api/targets/${t.dataset.deltarget}`, { method: 'DELETE' }); toast('Цель удалена'); route(); }
  };
}

boot();
})();
