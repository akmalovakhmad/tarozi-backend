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
const PAY = { cash: 'Наличные', card: 'Карта', debt: 'В долг', bonus: 'Бонусы', exchange: 'Обмен' };
const PAY_TAG = { cash: 'green', card: '', debt: 'red', bonus: 'amber', exchange: 'grey' };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const can = p => !!S.me?.permissions?.includes(p);
const opts = (list, sel, val = 'id', label = 'name', empty) =>
  (empty != null ? `<option value="">${esc(empty)}</option>` : '') +
  list.map(x => `<option value="${esc(x[val])}" ${String(x[val]) === String(sel ?? '') ? 'selected' : ''}>${esc(x[label])}</option>`).join('');
const initials = n => (n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const PALETTE = ['#5B5BD6', '#18885A', '#B86E0C', '#CF3B47', '#7A4FD0', '#0E7FA8'];
const tint = id => { const c = PALETTE[(+id || 0) % PALETTE.length]; return [`color-mix(in srgb, ${c} 14%, transparent)`, c]; };

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
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.innerHTML = (bad ? ICON.alert : ICON.check) + `<span>${esc(msg)}</span>`;
  box.append(t); while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
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
const I = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON = {
  search: I('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  alert: I('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>'),
  sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: I('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  logout: I('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
  user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>'),
  tag: I('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>'),
  percent: I('<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
  note: I('<path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/>'),
  box: I('<path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10"/>'),
  print: I('<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>'),
  swap: I('<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>'),
  pause: I('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  arrow: I('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  menu: I('<path d="M4 7h16M4 12h16M4 17h16"/>'),
};
const ICONS = {
  dashboard: I('<path d="M3 12l9-8 9 8M5 10v10h14V10"/>'),
  kassa: I('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 20h10M12 16v4M7 8h4"/>'),
  sales: I('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>'),
  products: I('<path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10"/>'),
  clients: I('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 11a3 3 0 1 0 0-6M22 21c0-3-2-5-5-5"/>'),
  suppliers: I('<path d="M1 7h13v10H1zM14 10h4l3 3v4h-7"/><circle cx="5" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
  debts: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>'),
  marketing: I('<path d="M3 11v2l13 5V6zM16 8a4 4 0 0 1 0 8M6 14l1 5h3l-1-4"/>'),
  reports: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  staff: I('<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>'),
};
const LOGO = `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="9" fill="#5B5BD6"/><path d="M17 8v18M9 12h16M9 12l-3 7h6zM25 12l-3 7h6zM12 26h10" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------- маршруты ----------
const ROUTES = {
  dashboard: { t: 'Главная', perm: 'reports.read', render: viewDashboard },
  kassa: { t: 'Касса', perm: 'sales.create', render: viewKassa },
  sales: { t: 'Продажи', perm: 'sales.read', render: viewSales },
  products: { t: 'Товары', perm: 'products.read', render: viewProducts },
  suppliers: { t: 'Поставщики', perm: 'stock.manage', render: viewSuppliers },
  clients: { t: 'Клиенты', perm: 'clients.read', render: viewClients },
  debts: { t: 'Долги', perm: 'clients.read', render: viewDebts },
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

const NAV_GROUPS = [['', ['dashboard', 'kassa', 'sales']], ['Склад', ['products', 'suppliers']], ['Клиенты', ['clients', 'debts', 'marketing']], ['Аналитика', ['reports']], ['Компания', ['staff', 'settings']]];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';
function theme() { return document.documentElement.dataset.theme || 'light'; }
function setTheme(t) { document.documentElement.dataset.theme = t; store.set('tz_theme', t); const b = $('[data-theme-btn]'); if (b) b.innerHTML = t === 'dark' ? ICON.sun : ICON.moon; if (location.hash === '#dashboard') route(); }
function renderShell() {
  const ok = allowed();
  const nav = NAV_GROUPS.map(([h, keys]) => { const ks = keys.filter(k => ok.includes(k)); return ks.length ? `${h ? `<div class="nav-h">${h}</div>` : ''}${ks.map(k => `<a href="#${k}" data-r="${k}">${ICONS[k]}<span>${ROUTES[k].t}</span>${k === 'debts' ? '<span class="badge" id="debtBadge" hidden></span>' : ''}</a>`).join('')}` : ''; }).join('');
  $('#root').innerHTML = `<div class="app">
    <header class="topbar"><button class="icon-btn" type="button" data-menu aria-label="Открыть меню">${ICON.menu}</button><b>Тарози</b><button class="icon-btn" type="button" data-cmdk aria-label="Поиск">${ICON.search}</button></header>
    <nav class="side" aria-label="Разделы">
      <div class="brand">${LOGO}<span>${esc(S.company.name)}</span></div>
      ${S.stores.length > 1 ? `<label class="store-pick"><span class="sr" hidden>Магазин</span><select id="storeSel" aria-label="Магазин">${opts(S.stores, S.storeId)}</select></label>` : ''}
      <button class="cmd-btn" type="button" data-cmdk>${ICON.search}<span>Поиск и команды</span><kbd>${MOD} K</kbd></button>
      <div class="nav">${nav}</div>
      <div class="side-foot"><div class="me"><span class="avatar">${esc(initials(S.me.name))}</span><span class="who"><b>${esc(S.me.name)}</b><small>${S.me.is_owner ? 'Владелец' : 'Сотрудник'}</small></span>
        <button class="icon-btn" type="button" data-theme-btn aria-label="Сменить тему">${theme() === 'dark' ? ICON.sun : ICON.moon}</button>
        <button class="icon-btn" type="button" data-logout aria-label="Выйти">${ICON.logout}</button></div></div>
    </nav>
    <main class="main" id="view"></main></div>`;
  $('.app').addEventListener('click', e => {
    if (e.target.closest('[data-menu]')) $('.app').classList.toggle('menu-open');
    else if (e.target.closest('.nav a')) $('.app').classList.remove('menu-open');
    if (e.target.closest('[data-logout]')) logout();
    if (e.target.closest('[data-theme-btn]')) setTheme(theme() === 'dark' ? 'light' : 'dark');
    if (e.target.closest('[data-cmdk]')) { $('.app').classList.remove('menu-open'); openCmdk(); }
  });
  $('#storeSel')?.addEventListener('change', e => { S.storeId = +e.target.value; store.set('tz_store', S.storeId); route(); });
  refreshBadges();
}
async function refreshBadges() {
  if (!can('clients.read')) return;
  try { const d = await api('/api/debts' + qs({ status: 'overdue', size: 1 })); const b = $('#debtBadge'); if (b) { b.textContent = d.summary.overdue; b.hidden = !d.summary.overdue; b.title = 'Просроченные долги'; } } catch { /* не критично */ }
}
const skeleton = () => `<div style="display:grid;gap:16px"><div class="sk" style="height:28px;width:240px"></div>
  <div class="kpis">${'<div class="sk" style="height:84px"></div>'.repeat(4)}</div><div class="sk" style="height:320px"></div></div>`;
function route() {
  if (!S.me) return;
  const list = allowed();
  let key = location.hash.slice(1);
  if (!list.includes(key)) { key = list[0]; if (!key) { $('#view').innerHTML = '<div class="panel empty">У вашей роли нет доступа ни к одному разделу. Попросите владельца выдать права.</div>'; return; } history.replaceState(null, '', '#' + key); }
  $$('.nav a').forEach(a => { const on = a.dataset.r === key; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  document.title = `${ROUTES[key].t} — Тарози`;
  const v = $('#view');
  v.innerHTML = skeleton(); v.classList.remove('has-cartbar', 'view-enter');
  $('.cartbar')?.remove();
  v.onclick = v.oninput = v.onchange = v.onkeydown = v.onsubmit = null;
  Promise.resolve(ROUTES[key].render(v)).then(() => { void v.offsetWidth; v.classList.add('view-enter'); })
    .catch(e => { v.innerHTML = `<div class="panel"><div class="err">${esc(e.message)}</div></div>`; });
}
window.addEventListener('hashchange', route);

// ---------- палитра команд (Ctrl/⌘ + K) ----------
function openCmdk() {
  if ($('.cmdk-bg') || !S.me) return;
  const bg = document.createElement('div');
  bg.className = 'cmdk-bg';
  bg.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true" aria-label="Поиск и команды"><div class="cmdk-in">${ICON.search}<input placeholder="Найти товар, клиента, чек № или команду…" aria-label="Поиск" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="cmdk-list" role="listbox"></div><div class="cmdk-f"><span><kbd>↑</kbd> <kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> открыть</span><span><kbd>${MOD} K</kbd> открыть отовсюду</span></div></div>`;
  document.body.append(bg);
  const input = $('input', bg), list = $('.cmdk-list', bg);
  let items = [], sel = 0, found = [], seq = 0, loading = false;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); };
  const base = () => {
    const nav = allowed().map(k => ({ g: 'Перейти', t: ROUTES[k].t, ic: ICONS[k], run: () => { location.hash = '#' + k; } }));
    const act = [
      can('sales.create') && { g: 'Действия', t: 'Новая продажа', ic: ICONS.kassa, r: 'касса', run: () => { location.hash = '#kassa'; } },
      can('products.write') && { g: 'Действия', t: 'Новый товар', ic: ICON.plus, run: () => productModal(null) },
      can('stock.manage') && { g: 'Действия', t: 'Приход товара', ic: ICON.box, run: () => stockInModal() },
      can('clients.write') && { g: 'Действия', t: 'Новый клиент', ic: ICON.user, run: () => clientModal(null, () => route()) },
      can('sales.return') && { g: 'Действия', t: 'Возврат или обмен', ic: ICON.swap, run: () => returnsModal() },
      { g: 'Действия', t: theme() === 'dark' ? 'Светлая тема' : 'Тёмная тема', ic: theme() === 'dark' ? ICON.sun : ICON.moon, run: () => setTheme(theme() === 'dark' ? 'light' : 'dark') },
      { g: 'Действия', t: 'Выйти', ic: ICON.logout, run: () => logout() },
    ].filter(Boolean);
    return [...act, ...nav];
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = [...found, ...base().filter(x => !q || x.t.toLowerCase().includes(q))];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let g = '';
    list.innerHTML = items.length ? items.map((x, i) => `${x.g !== g ? `<div class="cmdk-g">${esc(g = x.g)}</div>` : ''}<div class="cmdk-it ${i === sel ? 'sel' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">${x.ic || ''}<span>${esc(x.t)}</span>${x.r ? `<span class="r">${esc(x.r)}</span>` : ''}</div>`).join('')
      : `<p class="empty">${loading ? 'Ищу…' : `Ничего не найдено по «${esc(input.value)}»`}</p>`;
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const search = debounce(async () => {
    const q = input.value.trim(), my = ++seq;
    if (q.length < 2) { found = []; loading = false; draw(); return; }
    loading = true; draw();
    const jobs = [];
    if (can('products.read')) jobs.push(api('/api/products' + qs({ q, size: 6, store_id: S.storeId })).then(r => r.items.map(p => ({ g: 'Товары', t: p.name, ic: ICON.box, r: `${money(p.retail_price)} · ${p.is_service ? 'услуга' : num(stockOf(p)) + ' ' + p.unit}`, run: () => productModal(p) }))).catch(() => []));
    if (can('clients.read')) jobs.push(api('/api/clients' + qs({ q, size: 5 })).then(r => r.items.map(c => ({ g: 'Клиенты', t: c.name, ic: ICON.user, r: c.phone || '', run: () => clientCard(c) }))).catch(() => []));
    if (can('sales.read') && /^\d+$/.test(q)) jobs.push(api('/api/sales' + qs({ number: q, status: '' })).then(r => r.items.map(s => ({ g: 'Чеки', t: `Чек №${s.number}`, ic: ICONS.sales, r: `${fDateTime(s.created_at)} · ${money(s.total)}`, run: () => saleModal(s) }))).catch(() => []));
    const res = (await Promise.all(jobs)).flat();
    if (my !== seq) return;
    found = res; loading = false; sel = 0; draw();
  }, 180);
  const run = i => { const x = items[i]; if (!x) return; close(); x.run(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  };
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => { sel = 0; draw(); search(); });
  list.addEventListener('mousemove', e => { const it = e.target.closest('[data-i]'); if (it && +it.dataset.i !== sel) { sel = +it.dataset.i; list.querySelectorAll('.cmdk-it').forEach((n, i) => n.classList.toggle('sel', i === sel)); } });
  list.addEventListener('click', e => { const it = e.target.closest('[data-i]'); if (it) run(+it.dataset.i); });
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  draw(); input.focus();
}
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л')) { e.preventDefault(); openCmdk(); }
});

// ---------- вход и регистрация ----------
function renderAuth(mode = 'login') {
  const reg = mode === 'register';
  $('#root').innerHTML = `<div class="auth"><div>
    <form class="box" novalidate>
      <div class="brand">${LOGO}<span>Тарози</span></div>
      <div><h1>${reg ? 'Создать магазин' : 'Вход в Тарози'}</h1>
      <p class="sub">${reg ? 'Бизнес, первый магазин и аккаунт владельца — за минуту.' : 'Касса, склад и клиенты в одном окне.'}</p></div>
      ${reg ? field('Название бизнеса', inp('company_name', { req: true, ph: 'Например, Barber Shop' })) + '<div class="two" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + field('Первый магазин', inp('store_name', { req: true, ph: 'Чиланзар' })) + field('Валюта', `<select class="input" name="currency"><option>USD</option><option value="UZS">UZS</option><option>RUB</option><option>KZT</option><option>EUR</option></select>`) + '</div>' + field('Ваше имя', inp('owner_name', { req: true })) : ''}
      ${field('Логин', inp('login', { req: true, attrs: 'autocomplete="username" autocapitalize="none"' }))}
      ${field('Пароль', inp('password', { type: 'password', req: true, attrs: `autocomplete="${reg ? 'new-password' : 'current-password'}"`, ph: reg ? 'Не меньше 8 символов' : '' }))}
      <div class="err" hidden></div>
      <button class="btn big" type="submit">${reg ? 'Создать и войти' : 'Войти'}</button>
    </form>
    <p class="auth-foot">${reg ? 'Уже есть аккаунт?' : 'Ещё нет аккаунта?'} <a href="#" data-switch>${reg ? 'Войти' : 'Создать магазин'}</a></p></div></div>`;
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
const PERIODS = { today: ['Сегодня', 0], week: ['Неделя', 6], month: ['Месяц', 29], quarter: ['Квартал', 89], year: ['Год', 364], custom: ['Свой период', 0] };
function periodRange(key, shift = 0) {
  const days = PERIODS[key][1] + 1, end = addDays(new Date(), -shift * days);
  return { from: iso(addDays(end, -(days - 1))), to: iso(end) };
}
// свой диапазон дат: состояние раздела хранит period ('custom') и from/to
const PRESETS = { this_month: 'Этот месяц', last_month: 'Прошлый месяц', ytd: 'С начала года', last_90: '90 дней' };
function presetRange(k) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  if (k === 'this_month') return { from: iso(new Date(y, m, 1)), to: today() };
  if (k === 'last_month') return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
  if (k === 'ytd') return { from: `${y}-01-01`, to: today() };
  return { from: iso(addDays(n, -89)), to: today() };
}
function rangeOf(st) {
  if (st.period !== 'custom') return periodRange(st.period);
  return { from: st.from || iso(addDays(new Date(), -29)), to: st.to || today() };
}
const fLong = d => new Date(d + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const fRange = r => r.from === r.to ? fLong(r.from) : `${fLong(r.from)} — ${fLong(r.to)}`;
function rangeControls(st, keys) {
  const r = rangeOf(st);
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">${segPeriods(st.period, [...keys, 'custom'])}
    ${st.period === 'custom' ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input class="input" type="date" data-range="from" value="${r.from}" max="${today()}" aria-label="Начало периода" style="width:auto;height:30px">
      <span class="muted">—</span>
      <input class="input" type="date" data-range="to" value="${r.to}" max="${today()}" aria-label="Конец периода" style="width:auto;height:30px">
      ${Object.entries(PRESETS).map(([k, t]) => `<button type="button" class="chip" data-preset="${k}">${t}</button>`).join('')}</div>` : ''}</div>`;
}
// обработка кликов и изменений дат; возвращает true, если событие про период
function rangeEvent(st, e) {
  const pb = e.target.closest?.('[data-period]');
  if (pb && e.type === 'click') {
    if (pb.dataset.period === 'custom' && st.period !== 'custom') { const r = rangeOf(st); st.from = r.from; st.to = r.to; }
    st.period = pb.dataset.period; return true;
  }
  const pr = e.target.closest?.('[data-preset]');
  if (pr && e.type === 'click') { Object.assign(st, { period: 'custom' }, presetRange(pr.dataset.preset)); return true; }
  const d = e.target.dataset?.range;
  if (d && e.type === 'change' && e.target.value) {
    st[d] = e.target.value;
    if (st.from && st.to && st.from > st.to) [st.from, st.to] = [st.to, st.from];
    return true;
  }
  return false;
}
const segPeriods = (cur, keys = Object.keys(PERIODS)) => `<div class="seg" role="group" aria-label="Период">${keys.map(k =>
  `<button type="button" data-period="${k}" class="${k === cur ? 'on' : ''}" aria-pressed="${k === cur}">${PERIODS[k][0]}</button>`).join('')}</div>`;
const delta = (cur, prev) => {
  if (!prev) return cur ? '<small class="muted">нет данных за прошлый период</small>' : '<small>&nbsp;</small>';
  const p = Math.round((cur - prev) / prev * 100);
  return `<span class="delta ${p > 0 ? 'up' : p < 0 ? 'down' : 'flat'}">${p > 0 ? '↑' : p < 0 ? '↓' : ''}${Math.abs(p)}%</span> <small>к прошлому периоду</small>`;
};

// ================= ГЛАВНАЯ =================
const D = { period: store.get('tz_period') || 'week', store: '' };
const SERIES = [['cash', 'Наличные', 'var(--c-cash)'], ['card', 'Карта', 'var(--c-card)'], ['debt', 'В долг', 'var(--c-debt)'], ['bonus', 'Бонусы', 'var(--c-bonus)'], ['exchange', 'Обмен', 'var(--c-ex)']];
const short = v => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1).replace('.0', '') + 'K' : String(Math.round(v));
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function groupBars(rows, byMonth) {
  if (!byMonth) return rows.map(r => ({ ...r }));
  const m = new Map();
  for (const x of rows) { const k = x.date.slice(0, 7); const a = m.get(k) || { date: k }; for (const [f] of SERIES) a[f] = (a[f] || 0) + (x[f] || 0); a.net = (a.net || 0) + x.net; m.set(k, a); }
  return [...m.values()];
}
const dayLabel = (d, n) => d.length === 7 ? MONTHS[+d.slice(5) - 1] : n <= 7 ? WD[new Date(d + 'T00:00').getDay()] : fDay(d);
// столбцы по способам оплаты + пунктир прошлого периода; подсказка при наведении
function drawChart(box, bars, prev) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true;
  const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `График выручки: ${bars.map(b => `${dayLabel(b.date, bars.length)} ${num(Math.round(b.net))}`).join(', ')}`);
  box.append(svg, tip);
  const tot = b => SERIES.reduce((a, [f]) => a + (b[f] || 0), 0);
  const draw = () => {
    const W = box.clientWidth, H = box.clientHeight, L = 44, R = 6, T = 8, B = 26;
    if (W < 120 || H < 80) return;
    const max = niceMax(Math.max(1, ...bars.map(tot), ...(prev || []).map(p => p.net || 0)));
    const n = bars.length, step = (W - L - R) / n, bw = Math.max(3, Math.min(40, step * .62));
    const y = v => T + (H - T - B) * (1 - v / max), x = i => L + step * i + step / 2;
    const every = Math.ceil(n / Math.max(4, Math.floor((W - L) / 64)));
    let h = '';
    for (let k = 0; k <= 4; k++) { const v = max * k / 4, yy = y(v); h += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)" ${k ? 'stroke-dasharray="2 4"' : ''}/><text x="${L - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--faint)">${short(v)}</text>`; }
    bars.forEach((b, i) => {
      let acc = 0;
      const parts = SERIES.filter(([f]) => b[f] > 0);
      parts.forEach(([f, , c], j) => {
        const y0 = y(acc), y1 = y(acc + b[f]); acc += b[f];
        const top = j === parts.length - 1, r = top ? Math.min(4, bw / 2) : 0, hh = Math.max(0, y0 - y1);
        h += top && hh > r ? `<path d="M${x(i) - bw / 2},${y0}V${y1 + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${y0}z" fill="${c}"/>` : `<rect x="${x(i) - bw / 2}" y="${y1}" width="${bw}" height="${hh}" fill="${c}"/>`;
      });
      if (i % every === 0) h += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${dayLabel(b.date, n)}</text>`;
    });
    if (prev && prev.length === n) h += `<path d="${prev.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(Math.max(0, p.net))}`).join('')}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    h += `<rect class="hl" x="0" y="${T}" width="${step}" height="${H - T - B}" fill="var(--ink)" opacity="0" rx="6"/>`;
    svg.innerHTML = h;
    svg.onmousemove = e => {
      const r = svg.getBoundingClientRect(), i = Math.floor((e.clientX - r.left - L) / step);
      if (i < 0 || i >= n) { tip.hidden = true; return; }
      const b = bars[i], hl = svg.querySelector('.hl'); hl.setAttribute('x', L + step * i); hl.setAttribute('opacity', '.05');
      const name = b.date.length === 7 ? `${MONTHS[+b.date.slice(5) - 1]} ${b.date.slice(0, 4)}` : new Date(b.date + 'T00:00').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
      tip.innerHTML = `<b>${name}</b>${SERIES.filter(([f]) => b[f]).map(([f, t, c]) => `<div><span><i style="background:${c}"></i>${t}</span><span>${num(b[f])}</span></div>`).join('') || '<div class="muted">Продаж не было</div>'}
        <div style="border-top:1px solid var(--line);margin-top:5px;padding-top:5px"><span>Чистая выручка</span><b style="margin:0">${num(b.net)}</b></div>${prev?.[i] ? `<div class="muted"><span>Прошлый период</span><span>${num(prev[i].net)}</span></div>` : ''}`;
      tip.hidden = false;
      const tx = L + step * i + step / 2 + 14, tw = tip.offsetWidth;
      tip.style.left = (tx + tw > W ? tx - tw - 28 : tx) + 'px'; tip.style.top = Math.max(0, e.clientY - r.top - 40) + 'px';
    };
    svg.onmouseleave = () => { tip.hidden = true; svg.querySelector('.hl')?.setAttribute('opacity', '0'); };
  };
  new ResizeObserver(draw).observe(box);
}
function spark(vals, color = 'var(--accent)') {
  if (vals.length < 2 || !vals.some(v => v)) return '';
  const mx = Math.max(...vals, 1), mn = Math.min(...vals, 0), w = 72, h = 26;
  const pts = vals.map((v, i) => [i / (vals.length - 1) * w, h - 2 - (v - mn) / (mx - mn || 1) * (h - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}L${w},${h}L0,${h}z" fill="${color}" opacity=".1"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}
function donut(parts) {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1, r = 52, c = 2 * Math.PI * r;
  let off = 0;
  return `<svg class="donut" viewBox="0 0 128 128" role="img" aria-label="${esc(parts.map(p => `${p.t} ${Math.round(p.v / total * 100)}%`).join(', '))}"><circle cx="64" cy="64" r="${r}" fill="none" stroke="var(--sunken)" stroke-width="14"/>
    ${parts.filter(p => p.v > 0).map(p => { const len = p.v / total * c; const s = `<circle cx="64" cy="64" r="${r}" fill="none" stroke="${p.c}" stroke-width="14" stroke-dasharray="${Math.max(0, len - 2)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 64 64)"/>`; off += len; return s; }).join('')}
    <text x="64" y="61" text-anchor="middle" font-size="11" fill="var(--muted)">оплачено</text><text x="64" y="78" text-anchor="middle" font-size="15" font-weight="700" fill="var(--ink)">${short(total)}</text></svg>`;
}
async function viewDashboard(v) {
  const r = periodRange(D.period), pr = periodRange(D.period, 1);
  const sq = D.store ? { store_id: D.store } : {};
  const [d, prev, todays] = await Promise.all([
    api('/api/reports/dashboard' + qs({ ...sq, date_from: r.from, date_to: r.to })),
    api('/api/reports/dashboard' + qs({ ...sq, date_from: pr.from, date_to: pr.to })),
    can('sales.read') ? api('/api/sales' + qs({ ...sq, date_from: today(), date_to: today(), size: 40 })) : null,
  ]);
  const label = { today: 'сегодня', week: 'за неделю', month: 'за месяц', quarter: 'за квартал', year: 'за год' }[D.period];
  const net = d.revenue.net, checks = d.transactions.count, p = d.payments;
  const byMonth = D.period === 'year';
  const bars = groupBars(d.by_day, byMonth), prevBars = groupBars(prev.by_day, byMonth);
  const nets = d.by_day.map(x => x.net);
  const topP = d.top_products, maxP = Math.max(1, ...topP.map(x => x.net));
  const tgt = d.target;
  const payParts = SERIES.map(([f, t, c]) => ({ t, c, v: p[f] || 0 })).filter(x => x.v > 0);
  const payTotal = payParts.reduce((a, x) => a + x.v, 0);

  v.innerHTML = `
  <div class="head"><div><h1>Обзор</h1><p class="sub">${r.from === r.to ? fDay(r.from) : `${fDay(r.from)} — ${fDay(r.to)}`}${checks ? '' : ' · продаж пока нет — проведите первую на кассе'}</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${S.stores.length > 1 ? `<select class="input" id="dStore" style="width:auto;height:32px">${opts(S.stores, D.store, 'id', 'name', 'Все магазины')}</select>` : ''}
      ${segPeriods(D.period, ['today', 'week', 'month', 'year'])}
      ${can('sales.create') ? `<a class="btn" href="#kassa">${ICON.plus}Новая продажа</a>` : ''}</div></div>
  <div class="kpis">
    <div class="kpi"><span>Чистая выручка</span><b>${money(net)}</b>${delta(net, prev.revenue.net)}${spark(nets)}</div>
    <div class="kpi"><span>Чеков</span><b>${num(checks)}</b>${delta(checks, prev.transactions.count)}</div>
    <div class="kpi"><span>Средний чек</span><b>${money(d.transactions.average_check)}</b>${delta(d.transactions.average_check, prev.transactions.average_check)}</div>
    <div class="kpi"><span>Отдано в долг</span><b class="${p.debt ? 'bad' : ''}">${money(p.debt)}</b><small>${payTotal ? Math.round(p.debt / payTotal * 100) : 0}% от оплат${d.transactions.returns_count ? ` · возвратов ${d.transactions.returns_count}` : ''}</small>${spark(d.by_day.map(x => x.debt), 'var(--c-debt)')}</div>
  </div>
  <div class="row">
    <div class="grow grid">
      <section class="panel"><div class="head" style="align-items:baseline"><div><h2>Выручка ${label}</h2><p class="sub" style="margin:2px 0 0">${byMonth ? 'По месяцам' : 'По дням'}, разбивка по способам оплаты. Пунктир — прошлый период</p></div>
        <div class="legend">${SERIES.filter(([f]) => p[f]).map(([f, t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}<span><i style="background:none;border-top:2px dashed var(--faint);height:0;width:12px;vertical-align:3px"></i>Прошлый</span></div></div>
        <div class="chart" id="chart"></div></section>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))">
        <section class="panel"><h2>Лучшие товары</h2>${topP.length ? `<div class="blist">${topP.slice(0, 7).map(x => `<div class="it" style="--w:${(x.net / maxP * 100).toFixed(1)}%"><span>${esc(x.name)} <small class="muted">${num(x.qty)} шт</small></span><b>${money(x.net)}</b></div>`).join('')}</div>` : '<p class="empty">Нет продаж за период</p>'}</section>
        <section class="panel"><h2>Как платят</h2>${payParts.length ? `<div class="donut-wrap">${donut(payParts)}<div class="legend" style="display:grid;gap:6px;flex:1">${payParts.map(x => `<span style="display:flex;justify-content:space-between;gap:10px"><span><i style="background:${x.c}"></i>${x.t}</span><b class="num">${Math.round(x.v / payTotal * 100)}%</b></span>`).join('')}</div></div>` : '<p class="empty">Нет оплат за период</p>'}</section>
        <section class="panel" style="display:grid;gap:10px;align-content:start"><h2 style="margin:0">Продавцы</h2>
          ${d.top_sellers.length ? `<div class="blist">${d.top_sellers.slice(0, 5).map(x => `<div class="it" style="--w:${(x.net / Math.max(1, d.top_sellers[0].net) * 100).toFixed(1)}%"><span>${esc(x.name)}</span><b>${money(x.net)}</b></div>`).join('')}</div>` : '<p class="muted" style="margin:0">Нет продаж за период</p>'}
          ${tgt ? `<div style="padding:12px;background:var(--sunken);border-radius:10px;border:1px solid var(--line)">
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px"><span>Цель до ${fDay(tgt.period_end)}</span><span class="num"><b>${num(tgt.done)}</b> / ${money(tgt.amount)}</span></div>
            <div class="meter teal"><div style="width:${Math.min(100, tgt.percent)}%"></div></div>
            <span class="note">${tgt.percent >= 100 ? 'Цель выполнена' : `${tgt.percent}% · нужно ${money(tgt.per_day_needed)} в день`}</span></div>`
            : can('settings.manage') ? `<button class="btn ghost" type="button" data-a="target">${ICON.plus}Поставить цель по выручке</button>` : ''}
        </section></div>
    </div>
    ${todays ? `<aside class="aside"><div class="tape">
      <div class="head" style="align-items:center"><h2>Сегодня</h2><span class="live">${todays.total} ${plural(todays.total, 'чек', 'чека', 'чеков')}</span></div>
      <div class="line"></div>
      ${todays.items.length ? todays.items.slice(0, 12).map(s => `<div class="rcpt click" data-sale="${s.id}" style="cursor:pointer"><div class="t"><span class="muted">${fTime(s.created_at)} · №${s.number}</span><b>${money(s.total)}</b></div>
        <div class="t"><span>${esc(s.items.map(i => i.name).slice(0, 2).join(', '))}${s.items.length > 2 ? ` +${s.items.length - 2}` : ''}</span><span class="${s.payments.some(x => x.method === 'debt') ? 'bad' : 'muted'}">${esc(s.payments.map(x => PAY[x.method] || x.method).join(' + '))}</span></div></div>`).join('')
        : '<p class="empty">Сегодня ещё не было продаж</p>'}
      <div style="display:flex;justify-content:space-between;padding-top:10px;border-top:1px solid var(--line);margin-top:4px;font-weight:600"><span>Итого за день</span><span class="num">${money(todays.items.reduce((a, s) => a + s.total - s.returned_total, 0))}</span></div>
      <a class="btn ghost" href="#sales" style="width:100%;margin-top:12px">Все продажи</a>
    </div></aside>` : ''}</div>`;
  drawChart($('#chart', v), bars, prevBars.length === bars.length ? prevBars : null);
  v.onclick = e => {
    const pb = e.target.closest('[data-period]');
    if (pb) { D.period = pb.dataset.period; store.set('tz_period', D.period); route(); }
    if (e.target.closest('[data-a=target]')) targetModal();
    const rc = e.target.closest('[data-sale]'); if (rc) saleModal(todays.items.find(s => s.id === +rc.dataset.sale));
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
const K = { cat: '', q: '', products: [], cart: [], client: null, promo: '', quote: null, qErr: '', seller: null, sellers: [], wholesale: false,
  disc: '', discType: '%', note: '', panel: null, exchange: null, sel: -1 };
const PS = { method: 'cash', received: '', split: { cash: '', card: '', debt: '' }, due: '', bonus: '', refund: 'cash' };
async function viewKassa(v) {
  if (!S.storeId) { v.innerHTML = '<div class="panel empty">Нет доступного магазина. Владелец может добавить магазин в настройках.</div>'; return; }
  const [prods, sellers] = await Promise.all([api('/api/products' + qs({ status: 'active', size: 500, store_id: S.storeId })), api('/api/sales/sellers')]);
  K.products = prods.items; K.sellers = sellers;
  if (!K.seller || !sellers.some(s => s.id === K.seller)) K.seller = S.me.id;
  v.innerHTML = `<div class="head"><div><h1>${K.exchange ? `Обмен по чеку №${K.exchange.sale.number}` : 'Касса'}</h1><p class="sub">${esc(S.stores.find(s => s.id === S.storeId)?.name || '')} · <kbd>/</kbd> поиск · <kbd>J</kbd> клиент · <kbd>K</kbd> скидка · <kbd>L</kbd> оплатить · <kbd>O</kbd> отложить</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost" type="button" data-held>${ICON.pause}Отложенные</button>${can('sales.return') ? `<button class="btn ghost" type="button" data-returns>${ICON.swap}Возврат и обмен</button>` : ''}</div></div>
  <div class="pos"><section class="grid" aria-label="Товары" style="gap:12px">
    <label class="search" style="height:42px">${ICON.search}<input id="kq" placeholder="Название, артикул или штрихкод — Enter добавит" value="${esc(K.q)}" autocomplete="off" aria-label="Поиск товара"><kbd>/</kbd></label>
    <div class="chips" role="group" aria-label="Категории"><button type="button" class="chip ${!K.cat ? 'on' : ''}" data-cat="">Все</button>${S.cats.map(c => `<button type="button" class="chip ${K.cat === String(c.id) ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}</div>
    <div id="tiles">${kassaTiles()}</div></section>
    <aside id="check" aria-label="Чек">${kassaCart()}</aside></div>`;
  cartBar();
  bindKassa(v);
  requote();
}
const stockOf = p => +(p.stock?.[S.storeId] || 0);
const hasWholesale = () => K.products.some(p => p.wholesale_price != null);
const priceOf = p => (K.wholesale && p.wholesale_price != null ? p.wholesale_price : p.retail_price);
const visibleProducts = () => {
  const q = K.q.trim().toLowerCase();
  return K.products.filter(p => (!K.cat || String(p.category_id) === K.cat) &&
    (!q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode || '') === q)).slice(0, 120);
};
function kassaTiles() {
  const list = visibleProducts();
  if (!K.products.length) return `<div class="panel empty">В каталоге пока нет товаров. ${can('products.write') ? '<a href="#products">Добавьте первый товар</a>' : 'Попросите менеджера добавить товары'}.</div>`;
  if (!list.length) return '<div class="panel empty">Ничего не найдено. Проверьте название или отсканируйте штрихкод ещё раз.</div>';
  const neg = S.company.allow_negative_stock, inCart = Object.fromEntries(K.cart.map(l => [l.p.id, l.qty]));
  return `<div class="tiles">${list.map((p, i) => {
    const st = stockOf(p), out = !p.is_service && st <= 0 && !neg, [bg, fg] = tint(p.category_id || p.id);
    return `<button class="tile ${i === K.sel ? 'sel' : ''}" type="button" data-add="${p.id}" ${out ? 'disabled' : ''}>
      ${inCart[p.id] ? `<span class="cnt">${num(inCart[p.id])}</span>` : ''}
      <span class="pic" style="background:${bg};color:${fg}" aria-hidden="true">${esc(initials(p.name))}</span>
      <span class="nm">${esc(p.name)}</span>
      <span class="pr"><b>${money(priceOf(p))}</b><small class="${p.is_service ? 'muted' : st <= 0 ? 'bad' : st <= +S.company.low_stock_threshold ? 'warn' : 'muted'}">${p.is_service ? 'услуга' : st <= 0 ? 'нет' : `${num(st)} ${esc(p.unit)}`}</small></span></button>`;
  }).join('')}</div>`;
}
const drawTiles = () => { const t = $('#tiles'); if (t) t.innerHTML = kassaTiles(); };
const checkClient = () => (K.exchange ? K.exchange.client : K.client);
function totals() {
  const q = K.quote, total = q?.total ?? K.cart.reduce((a, l) => a + l.qty * priceOf(l.p), 0);
  const credit = K.exchange ? K.exchange.credit : 0;
  return { total, credit, toPay: Math.max(0, +(total - credit).toFixed(2)), refund: Math.max(0, +(credit - total).toFixed(2)) };
}
function kassaCart() {
  const q = K.quote, c = checkClient(), t = totals();
  const n = K.cart.reduce((a, l) => a + l.qty, 0);
  const lines = K.cart.map((l, i) => {
    const qi = q?.items?.[i];
    return `<div class="cart-line"><div class="t"><span>${esc(l.p.name)}</span><b>${money(qi ? qi.total : priceOf(l.p) * l.qty)}</b></div>
      <div class="qty"><button type="button" data-dec="${i}" aria-label="Меньше">−</button><input data-qty="${i}" value="${num(l.qty).replace(/\s/g, '')}" inputmode="decimal" aria-label="Количество">
      <button type="button" data-inc="${i}" aria-label="Больше">+</button><span style="margin-left:auto">× ${num(qi ? qi.price : priceOf(l.p))}${qi?.discount ? ` · <span class="good">−${num(qi.discount)}${qi.promotion ? ' ' + esc(qi.promotion) : ''}</span>` : ''}</span></div></div>`;
  }).join('');
  const discOn = +K.disc > 0, sellerName = K.sellers.find(s => s.id === K.seller)?.name;
  const panel = K.panel === 'disc' ? `<div class="field"><span>Ручная скидка</span><div style="display:flex;gap:6px;align-items:center"><input class="input" id="kDisc" type="number" min="0" step="0.01" value="${esc(K.disc)}" placeholder="0">
      <div class="seg"><button type="button" data-dt="%" class="${K.discType === '%' ? 'on' : ''}">%</button><button type="button" data-dt="sum" class="${K.discType === 'sum' ? 'on' : ''}">${esc(S.company.currency || 'сумма')}</button></div></div>
      <div class="chips">${[5, 10, 15, 30, 50].map(x => `<button type="button" class="chip" data-quick="${x}">${x}%</button>`).join('')}${discOn ? '<button type="button" class="chip" data-quick="0">Убрать</button>' : ''}</div></div>`
    : K.panel === 'promo' ? `<div style="display:flex;gap:6px"><input class="input" id="promo" placeholder="Промокод" value="${esc(K.promo)}" style="text-transform:uppercase" aria-label="Промокод"><button class="btn ghost" type="button" data-promo>Применить</button></div>`
    : K.panel === 'note' ? `<textarea class="input" id="kNote" placeholder="Заметка к чеку" style="min-height:56px">${esc(K.note)}</textarea>`
    : K.panel === 'seller' ? `<select class="input" id="kSeller" aria-label="Продавец">${opts(K.sellers, K.seller)}</select>` : '';
  return `<div class="cart">
    <div class="cart-h"><div class="t"><h2>${K.exchange ? 'Новые товары' : 'Чек'} ${n ? `<span class="muted" style="font-weight:500">· ${num(n)} шт</span>` : ''}</h2>
      ${K.cart.length || K.exchange ? `<button class="btn link sm" style="color:var(--red)" type="button" data-clear>${K.exchange ? 'Отменить обмен' : 'Очистить'}</button>` : ''}</div>
      ${K.exchange ? `<div class="ok-msg" style="background:var(--accent-soft);color:var(--accent-ink)">Возврат: ${esc(K.exchange.items.map(i => `${i.name} × ${num(i.qty)}`).join(', '))} — в зачёт ${money(K.exchange.credit)}</div>` : ''}
      ${c ? `<div class="client-box"><span class="avatar">${esc(initials(c.name))}</span><span style="flex:1;line-height:1.3"><b>${esc(c.name)}</b><br><small class="muted">${esc(c.phone || '')}${+c.bonus_balance ? ` · бонусы ${num(c.bonus_balance)}` : ''}${+c.debt_balance ? ` · <span class="bad">долг ${num(c.debt_balance)}</span>` : ''}</small></span>${K.exchange ? '' : '<button class="x" type="button" data-unclient aria-label="Убрать клиента">×</button>'}</div>`
        : `<div class="dd"><label class="search" style="height:34px;box-shadow:none">${ICON.user}<input id="cSearch" placeholder="Клиент — имя или телефон" autocomplete="off" aria-label="Найти клиента"><kbd>J</kbd></label><div class="dd-list" id="cList" hidden></div></div>`}
      ${K.exchange ? '' : `<div class="opts">
        ${K.sellers.length > 1 ? `<button type="button" class="opt ${K.panel === 'seller' ? 'on' : ''}" data-panel="seller">${ICON.user}${esc(sellerName || 'Продавец')}</button>` : ''}
        ${can('sales.discount') ? `<button type="button" class="opt ${discOn || K.panel === 'disc' ? 'on' : ''}" data-panel="disc">${ICON.percent}${discOn ? `Скидка ${num(K.disc)}${K.discType === '%' ? '%' : ''}` : 'Скидка'}</button>` : ''}
        <button type="button" class="opt ${K.promo || K.panel === 'promo' ? 'on' : ''}" data-panel="promo">${ICON.tag}${K.promo ? esc(K.promo) : 'Промокод'}</button>
        <button type="button" class="opt ${K.note || K.panel === 'note' ? 'on' : ''}" data-panel="note">${ICON.note}Заметка</button>
        ${hasWholesale() ? `<label class="opt ${K.wholesale ? 'on' : ''}" style="cursor:pointer"><span class="switch" style="transform:scale(.8)"><input type="checkbox" id="kWholesale" ${K.wholesale ? 'checked' : ''}><i></i></span>Опт</label>` : ''}
      </div>${panel}`}
    </div>
    <div class="cart-b">${K.cart.length ? lines : `<div class="empty" style="padding:28px 8px">${ICONS.kassa.replace('<svg', '<svg style="width:28px;height:28px;color:var(--faint)"')}<br>Добавьте товар: клик по карточке,<br>сканер штрихкода или <kbd>/</kbd> для поиска</div>`}</div>
    ${K.cart.length ? `<div class="cart-f">
      <div class="sumrow"><span>Без скидок</span><b>${num(q?.subtotal ?? t.total)}</b></div>
      ${q?.discount ? `<div class="sumrow"><span>Скидка</span><b class="good">−${num(q.discount)}</b></div>` : ''}
      ${K.exchange ? `<div class="sumrow"><span>Зачёт по обмену</span><b>−${num(Math.min(t.credit, t.total))}</b></div>` : ''}
      ${K.qErr ? `<div class="err">${esc(K.qErr)}</div>` : ''}
      <div class="total"><span style="font-weight:600">${t.refund ? 'Вернуть клиенту' : 'Итого'}</span><b>${num(t.refund || t.toPay)}</b></div>
      <button class="btn big" type="button" data-pay ${K.qErr ? 'disabled' : ''}>${K.exchange ? 'Провести обмен' : `Оплатить ${money(t.toPay)}`} <span class="k">L</span></button>
      ${K.exchange ? '' : `<button class="btn ghost" type="button" data-hold>${ICON.pause}Отложить <span class="k">O</span></button>`}
    </div>` : ''}
  </div>`;
}
function cartBar() {
  $('.cartbar')?.remove(); $('#view')?.classList.remove('has-cartbar');
  if (!K.cart.length || !$('#check')) return;
  const n = K.cart.reduce((a, l) => a + l.qty, 0);
  const bar = document.createElement('div'); bar.className = 'cartbar';
  bar.innerHTML = `<span>${num(n)} ${plural(Math.round(n), 'товар', 'товара', 'товаров')} · <b class="num">${money(totals().toPay)}</b></span><button class="btn sm" type="button">К чеку</button>`;
  bar.querySelector('button').onclick = () => $('#check').scrollIntoView({ behavior: 'smooth' });
  $('#view').append(bar); $('#view').classList.add('has-cartbar');
}
const redrawCheck = () => {
  cartBar(); const el = $('#check'); if (!el) return;
  const f = document.activeElement, id = f?.id;
  el.innerHTML = kassaCart();
  const x = id ? $('#' + id) : null;
  if (x && x !== document.body) { x.focus(); try { const n = x.value.length; x.setSelectionRange(n, n); } catch { /* number */ } }
};
const discBody = () => { const d = +K.disc || 0; if (!d) return {}; return K.discType === '%' ? { manual_discount_percent: Math.min(100, d) } : { manual_discount_amount: d }; };
const requote = debounce(async () => {
  if (!K.cart.length) { K.quote = null; K.qErr = ''; redrawCheck(); return; }
  try {
    K.quote = await api('/api/sales/quote', { method: 'POST', body: { store_id: S.storeId, client_id: checkClient()?.id, promo_code: K.exchange ? null : (K.promo || null),
      wholesale: K.exchange ? false : K.wholesale, ...(K.exchange ? {} : discBody()), items: K.cart.map(l => ({ product_id: l.p.id, qty: l.qty })) } });
    K.qErr = '';
  } catch (e) { K.qErr = e.message; }
  redrawCheck();
}, 180);
function addToCart(p) {
  if (!p) return;
  const l = K.cart.find(x => x.p.id === p.id);
  if (l) l.qty += 1; else K.cart.push({ p, qty: 1 });
  redrawCheck(); drawTiles(); requote();
}
function resetCheck() {
  Object.assign(K, { cart: [], client: null, promo: '', quote: null, qErr: '', disc: '', note: '', panel: null, exchange: null, wholesale: false, sel: -1 });
  Object.assign(PS, { method: 'cash', received: '', split: { cash: '', card: '', debt: '' }, due: '', bonus: '', refund: 'cash' });
}
function bindKassa(v) {
  const searchClients = debounce(async q => {
    const box = $('#cList'); if (!box) return;
    if (!q.trim()) { box.hidden = true; return; }
    const r = await api('/api/clients' + qs({ q, size: 8 })).catch(() => ({ items: [] }));
    box.innerHTML = r.items.map(c => `<button type="button" data-client='${esc(JSON.stringify(c))}'><b>${esc(c.name)}</b> <span class="muted">${esc(c.phone || '')}</span></button>`).join('') +
      (can('clients.write') ? `<button type="button" data-newclient="${esc(q)}">${ICON.plus.replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')} Новый клиент «${esc(q)}»</button>` : '') || '<div class="empty" style="padding:10px">Не найдено</div>';
    box.hidden = false;
  }, 220);
  const reDisc = debounce(() => requote(), 300);
  v.oninput = e => {
    const t = e.target;
    if (t.id === 'kq') { K.q = t.value; K.sel = t.value.trim() ? 0 : -1; drawTiles(); }
    if (t.id === 'cSearch') searchClients(t.value);
    if (t.id === 'promo') K.promo = t.value.trim().toUpperCase();
    if (t.id === 'kDisc') { K.disc = t.value; reDisc(); }
    if (t.id === 'kNote') K.note = t.value;
  };
  v.onchange = e => {
    const t = e.target, i = t.dataset.qty;
    if (i != null) { const q = nOrNull(t.value); if (q > 0) K.cart[i].qty = q; else K.cart.splice(i, 1); redrawCheck(); drawTiles(); requote(); }
    if (t.id === 'kSeller') { K.seller = +t.value; K.panel = null; redrawCheck(); }
    if (t.id === 'kWholesale') { K.wholesale = t.checked; drawTiles(); requote(); }
  };
  v.onkeydown = async e => {
    if (e.target.id === 'kq') {
      const list = visibleProducts(), cols = Math.max(1, Math.round(($('#tiles .tiles')?.clientWidth || 600) / 160));
      if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key) && list.length) {
        e.preventDefault();
        const step = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[e.key];
        K.sel = Math.max(0, Math.min(list.length - 1, (K.sel < 0 ? 0 : K.sel + step)));
        drawTiles(); $('#tiles .tile.sel')?.scrollIntoView({ block: 'nearest' }); return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const code = K.q.trim();
        let p = code ? K.products.find(x => x.barcode === code || x.sku === code) : null;
        if (!p && K.sel >= 0) p = list[K.sel];
        if (!p && code) { try { p = await api('/api/products/barcode/' + encodeURIComponent(code)); } catch { toast(`Товар «${code}» не найден`, true); return; } }
        if (p) { addToCart(p); K.q = ''; K.sel = -1; e.target.value = ''; drawTiles(); }
      }
      if (e.key === 'Escape') { K.q = ''; K.sel = -1; e.target.value = ''; e.target.blur(); drawTiles(); }
    }
    if (e.target.id === 'promo' && e.key === 'Enter') { e.preventDefault(); K.panel = null; requote(); }
  };
  v.onclick = async e => {
    const t = e.target.closest('button,a'); if (!t) return;
    const d = t.dataset;
    if (d.add) addToCart(K.products.find(p => p.id === +d.add));
    else if (d.cat != null) { K.cat = d.cat; K.sel = -1; $$('.chip[data-cat]', v).forEach(c => c.classList.toggle('on', c.dataset.cat === d.cat)); drawTiles(); }
    else if (d.inc) { K.cart[d.inc].qty += 1; redrawCheck(); drawTiles(); requote(); }
    else if (d.dec) { const l = K.cart[d.dec]; l.qty -= 1; if (l.qty <= 0) K.cart.splice(d.dec, 1); redrawCheck(); drawTiles(); requote(); }
    else if ('clear' in d) { const ex = !!K.exchange; resetCheck(); ex ? route() : (redrawCheck(), drawTiles()); }
    else if (d.panel) { K.panel = K.panel === d.panel ? null : d.panel; redrawCheck(); $({ disc: '#kDisc', promo: '#promo', note: '#kNote', seller: '#kSeller' }[K.panel] || '#none')?.focus(); }
    else if (d.dt) { K.discType = d.dt; redrawCheck(); requote(); }
    else if (d.quick) { K.discType = '%'; K.disc = d.quick === '0' ? '' : d.quick; if (d.quick === '0') K.panel = null; redrawCheck(); requote(); }
    else if ('promo' in d) { K.panel = null; requote(); }
    else if (d.client) { K.client = JSON.parse(d.client); redrawCheck(); requote(); }
    else if ('unclient' in d) { K.client = null; if (PS.method === 'debt') PS.method = 'cash'; redrawCheck(); requote(); }
    else if (d.newclient != null) clientModal(null, c => { K.client = c; redrawCheck(); requote(); }, { name: d.newclient });
    else if ('pay' in d) openPay();
    else if ('hold' in d) holdCheck();
    else if ('held' in d) heldModal();
    else if ('returns' in d) returnsModal();
  };
}
// горячие клавиши кассы (как в BILLZ): работают, когда фокус не в поле ввода
document.addEventListener('keydown', e => {
  if (location.hash !== '#kassa' || !$('#check') || $('.modal-bg') || $('.cmdk-bg')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape' && typing) { document.activeElement.blur(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const map = { '/': () => $('#kq')?.focus(), '.': () => $('#kq')?.focus(), j: () => $('#cSearch')?.focus(), о: () => $('#cSearch')?.focus(),
    k: () => $('[data-panel=disc]')?.click(), л: () => $('[data-panel=disc]')?.click(),
    l: () => $('[data-pay]:not(:disabled)')?.click(), д: () => $('[data-pay]:not(:disabled)')?.click(), o: () => $('[data-hold]')?.click(), щ: () => $('[data-hold]')?.click() };
  if (map[k]) { e.preventDefault(); map[k](); }
});
async function holdCheck() {
  if (!K.cart.length) return;
  try {
    const sale = await api('/api/sales', { method: 'POST', body: { store_id: S.storeId, client_id: K.client?.id, promo_code: K.promo || null, hold: true, seller_id: K.seller,
      items: K.cart.map(l => ({ product_id: l.p.id, qty: l.qty })), wholesale: K.wholesale, ...discBody(), comment: K.note || null } });
    resetCheck(); redrawCheck(); drawTiles(); toast(`Чек №${sale.number} отложен`);
  } catch (e) { toast(e.message, true); }
}
// ----- экран оплаты -----
function openPay() {
  if (!K.cart.length || !K.quote) return;
  Object.assign(PS, { received: '', split: { cash: '', card: '', debt: '' }, bonus: '' });
  if (PS.method === 'debt' && !checkClient()) PS.method = 'cash';
  const m = modal(K.exchange ? 'Обмен' : 'Оплата', '<div id="payBody"></div>');
  const body = $('#payBody', m.el);
  const st = () => {
    const t = totals(), c = checkClient(), q = K.quote;
    const bonusMax = K.exchange ? 0 : (q?.bonus_max_for_this_sale ?? 0), bonus = Math.min(+PS.bonus || 0, bonusMax);
    const toPay = Math.max(0, +(t.toPay - bonus).toFixed(2));
    let payments = [];
    if (toPay > 0) payments = PS.method === 'split' ? ['cash', 'card', 'debt'].map(x => ({ method: x, amount: +(+PS.split[x] || 0).toFixed(2) })).filter(x => x.amount > 0) : [{ method: PS.method, amount: toPay }];
    const given = +payments.reduce((a, x) => a + x.amount, 0).toFixed(2);
    const usesDebt = payments.some(x => x.method === 'debt');
    const change = PS.method === 'cash' && +PS.received > toPay ? +(+PS.received - toPay).toFixed(2) : 0;
    const ok = !(usesDebt && !c) && (toPay === 0 || given === toPay) && !(PS.method === 'cash' && PS.received && +PS.received < toPay);
    return { t, c, bonusMax, bonus, toPay, payments, given, usesDebt, change, ok };
  };
  const quick = v => { const r = [v]; for (const s of [5, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000]) { const x = Math.ceil(v / s) * s; if (x > v && !r.includes(x)) r.push(x); if (r.length >= 4) break; } return r; };
  const draw = () => {
    const s = st();
    body.innerHTML = `<div style="display:grid;gap:14px">
      <div class="amount-display"><span class="muted">${s.t.refund ? 'Вернуть клиенту' : 'К оплате'}</span><b>${money(s.t.refund || s.toPay)}</b></div>
      ${s.t.refund ? `<div class="pays">${['cash', 'card'].map(x => `<button type="button" data-refund="${x}" class="${PS.refund === x ? 'on' : ''}">${x === 'cash' ? 'Наличными' : 'На карту'}</button>`).join('')}</div>` : ''}
      ${s.toPay > 0 ? `<div class="pays" role="group" aria-label="Способ оплаты">${[['cash', 'Наличные', ''], ['card', 'Карта', ''], ['debt', 'В долг', s.c ? '' : 'нужен клиент'], ['split', 'Частями', 'наличные + карта']].map(([x, t, h]) => `<button type="button" data-m="${x}" class="${PS.method === x ? 'on' : ''}" ${x === 'debt' && !s.c ? 'disabled' : ''}>${t}${h ? `<small>${h}</small>` : ''}</button>`).join('')}</div>` : ''}
      ${s.toPay > 0 && PS.method === 'cash' ? `<div class="amount-display" style="background:var(--panel)"><span class="muted">Получено</span><b>${PS.received ? num(+PS.received) : '<span class="muted">—</span>'}</b></div>
        <div class="chips">${quick(s.toPay).map((x, i) => `<button type="button" class="chip" data-q="${x}">${i ? num(x) : 'Без сдачи'}</button>`).join('')}</div>
        <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'].map(k => `<button type="button" data-k="${k}" aria-label="${k === '⌫' ? 'Стереть' : k}">${k}</button>`).join('')}</div>
        ${s.change ? `<div class="ok-msg" style="display:flex;justify-content:space-between;font-size:15px"><span>Сдача</span><b>${money(s.change)}</b></div>` : PS.received && +PS.received < s.toPay ? `<div class="err">Не хватает ${money(s.toPay - +PS.received)}</div>` : ''}` : ''}
      ${s.toPay > 0 && PS.method === 'split' ? `<div class="form"><div class="two" style="grid-template-columns:repeat(${s.c ? 3 : 2},minmax(0,1fr))">${['cash', 'card'].concat(s.c ? ['debt'] : []).map(x => field(PAY[x], `<input class="input" data-split="${x}" type="number" min="0" step="0.01" value="${esc(PS.split[x])}">`)).join('')}</div>
        <div class="note ${s.given === s.toPay ? 'good' : 'bad'}">${s.given === s.toPay ? 'Сумма сходится' : s.given < s.toPay ? `Осталось распределить ${money(s.toPay - s.given)}` : `Больше суммы на ${money(s.given - s.toPay)}`}</div></div>` : ''}
      ${s.usesDebt && s.c ? field('Вернуть долг до', `<input class="input" id="pDue" type="date" value="${esc(PS.due || iso(addDays(new Date(), S.company.debt_days_default || 30)))}">`) : ''}
      ${s.bonusMax > 0 ? field(`Списать бонусы (доступно ${num(s.bonusMax)})`, `<input class="input" id="pBonus" type="number" min="0" step="0.01" max="${s.bonusMax}" value="${esc(PS.bonus)}">`) : ''}
      <div class="err" id="payErr" hidden></div>
      <button class="btn big" type="button" data-confirm ${s.ok ? '' : 'disabled'}>${ICON.check}${K.exchange ? 'Провести обмен' : 'Провести продажу'} <span class="k">Enter</span></button>
    </div>`;
  };
  const focusKeep = () => { const a = document.activeElement; return a && body.contains(a) && a.id ? '#' + a.id : a?.dataset?.split ? `[data-split="${a.dataset.split}"]` : null; };
  const redraw = () => { const f = focusKeep(); draw(); const x = f ? $(f, body) : null; if (x) { x.focus(); try { const n = x.value.length; x.setSelectionRange(n, n); } catch { /* number */ } } else $('[data-confirm]', body)?.focus(); };
  const press = k => { if (k === '⌫') PS.received = PS.received.slice(0, -1); else if (PS.received.length < 12) PS.received = (PS.received === '0' ? '' : PS.received) + k; redraw(); };
  let done = false;
  const confirm = async () => {
    const s = st(); if (!s.ok || done) return;
    const btn = $('[data-confirm]', body); btn.disabled = true;
    const items = K.cart.map(l => ({ product_id: l.p.id, qty: l.qty }));
    try {
      let sale, refund = 0;
      if (K.exchange) {
        const r = await api(`/api/sales/${K.exchange.sale.id}/exchange`, { method: 'POST', body: { return_items: K.exchange.items.map(i => ({ sale_item_id: i.sale_item_id, qty: i.qty })), items,
          seller_id: K.seller, payments: s.payments, refund_method: PS.refund, comment: K.note || null } });
        sale = r.sale; refund = r.refund;
      } else {
        sale = await api('/api/sales', { method: 'POST', body: { store_id: S.storeId, client_id: K.client?.id, promo_code: K.promo || null, items, seller_id: K.seller, wholesale: K.wholesale, ...discBody(),
          comment: K.note || null, bonus_to_use: s.bonus, payments: s.payments, debt_due_date: s.usesDebt ? (PS.due || iso(addDays(new Date(), S.company.debt_days_default || 30))) : null } });
      }
      done = true;
      const ex = !!K.exchange;
      resetCheck();
      $('.modal-h h2', m.el).textContent = 'Готово';
      body.innerHTML = `<div class="done-screen"><div class="check-ic">${ICON.check}</div>
        <div><h2 style="font-size:18px">${ex ? 'Обмен проведён' : 'Оплачено'} · чек №${sale.number}</h2><p class="sub">${money(sale.total)}${sale.bonus_earned ? ` · начислено бонусов ${num(sale.bonus_earned)}` : ''}</p></div>
        ${s.change ? `<div><div class="muted">Сдача</div><div class="change">${money(s.change)}</div></div>` : ''}
        ${refund ? `<div><div class="muted">Вернуть клиенту ${PS.refund === 'card' ? 'на карту' : 'наличными'}</div><div class="change">${money(refund)}</div></div>` : ''}
        <div style="display:grid;gap:8px;width:100%"><button class="btn big" type="button" data-next>Новая продажа <span class="k">Enter</span></button><button class="btn ghost" type="button" data-print>${ICON.print}Печать чека</button></div></div>`;
      $('[data-print]', body).onclick = () => printReceipt(sale);
      $('[data-next]', body).onclick = () => m.close();
      $('[data-next]', body).focus();
      api('/api/products' + qs({ status: 'active', size: 500, store_id: S.storeId })).then(r => { K.products = r.items; if (ex) route(); else { drawTiles(); redrawCheck(); } });
      refreshBadges();
    } catch (x) { const er = $('#payErr', body); er.textContent = x.message; er.hidden = false; btn.disabled = false; }
  };
  body.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.m) { PS.method = b.dataset.m; redraw(); }
    else if (b.dataset.k) press(b.dataset.k);
    else if (b.dataset.q) { PS.received = String(b.dataset.q); redraw(); }
    else if (b.dataset.refund) { PS.refund = b.dataset.refund; redraw(); }
    else if ('confirm' in b.dataset) confirm();
  });
  body.addEventListener('input', e => {
    if (e.target.dataset.split) { PS.split[e.target.dataset.split] = e.target.value; redraw(); }
    if (e.target.id === 'pBonus') { PS.bonus = e.target.value; redraw(); }
    if (e.target.id === 'pDue') PS.due = e.target.value;
  });
  const onKey = e => {
    if (!m.el.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Enter' && !(e.target.tagName === 'BUTTON' && !e.target.dataset.next && !e.target.dataset.confirm)) { e.preventDefault(); done ? m.close() : confirm(); return; }
    if (done || inField || PS.method !== 'cash') return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); }
  };
  document.addEventListener('keydown', onKey);
  draw();
  setTimeout(() => $('[data-confirm]', body)?.focus(), 40);
}
async function heldModal() {
  const list = await api('/api/sales/held' + qs({ store_id: S.storeId }));
  const m = modal('Отложенные чеки', list.length ? list.map(s => `<div class="rcpt">
    <div class="t"><span><b>№${s.number}</b> <span class="muted">· ${fDateTime(s.created_at)}</span></span><b>${money(s.total)}</b></div>
    <div class="t"><span class="muted">${esc(s.items.map(i => `${i.name} × ${num(i.qty)}`).join(', '))}</span></div>
    ${s.comment ? `<div class="note">${esc(s.comment)}</div>` : ''}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn sm" data-paid="${s.id}" data-m="cash">Наличными</button><button class="btn sm ghost" data-paid="${s.id}" data-m="card">Картой</button>
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
async function returnsModal() {
  const m = modal('Возврат и обмен', `<label class="search" style="margin-bottom:12px">${ICON.search}<input id="rq" type="number" placeholder="Номер чека" aria-label="Номер чека"></label><p class="note" style="margin:0 0 8px">Чеки за последние 14 дней. Откройте чек, отметьте товары и выберите возврат или обмен.</p><div id="rlist"><div class="sk" style="height:180px"></div></div>`, { wide: true });
  const load = async n => {
    const r = await api('/api/sales' + qs({ number: n || '', date_from: n ? '' : iso(addDays(new Date(), -13)), date_to: n ? '' : today(), size: 30, store_id: S.stores.length > 1 ? S.storeId : '' }));
    $('#rlist', m.el).innerHTML = r.items.length ? r.items.map(s => `<div class="rcpt" data-sale="${s.id}" style="cursor:pointer"><div class="t"><span><b>№${s.number}</b> <span class="muted">· ${fDateTime(s.created_at)}</span></span><b>${money(s.total)}</b></div>
      <div class="t"><span class="muted">${esc(s.items.map(i => i.name).slice(0, 3).join(', '))}</span><span class="muted">${s.items.reduce((a, i) => a + i.qty, 0)} шт</span></div></div>`).join('') : '<p class="empty">Чеков не найдено</p>';
    $('#rlist', m.el).onclick = e => { const x = e.target.closest('[data-sale]'); if (x) { m.close(); saleModal(r.items.find(s => s.id === +x.dataset.sale)); } };
  };
  $('#rq', m.el).oninput = debounce(e => load(e.target.value), 300);
  load('');
}
function startExchange(sale, items, client) {
  resetCheck();
  K.exchange = { sale, items, credit: +items.reduce((a, i) => a + i.amount, 0).toFixed(2), client };
  if (location.hash === '#kassa') route(); else location.hash = '#kassa';
}
function printReceipt(s) {
  const st = S.stores.find(x => x.id === s.store_id)?.name || '';
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) { toast('Браузер заблокировал окно печати. Разрешите всплывающие окна для этого сайта', true); return; }
  w.document.write(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Чек №${s.number}</title><style>
    body{font:13px/1.45 "JetBrains Mono",ui-monospace,Menlo,monospace;margin:0;padding:16px;width:280px;color:#000}
    h1{font-size:16px;text-align:center;margin:0 0 2px}p{margin:0;text-align:center}.r{display:flex;justify-content:space-between;gap:8px}
    hr{border:0;border-top:1px dashed #000;margin:8px 0}.b{font-weight:700;font-size:15px}@media print{@page{margin:0}}</style></head><body>
    <h1>${esc(S.company.name)}</h1><p>${esc(st)}</p><p>Чек №${s.number}</p><p>${fDateTime(s.created_at)}</p><hr>
    ${s.items.map(i => `<div>${esc(i.name)}</div><div class="r"><span>${num(i.qty)} × ${num(i.price)}</span><span>${num(i.price * i.qty)}</span></div>${i.discount ? `<div class="r"><span>скидка</span><span>−${num(i.discount)}</span></div>` : ''}`).join('')}
    <hr>${s.discount ? `<div class="r"><span>Скидка</span><span>−${num(s.discount)}</span></div>` : ''}<div class="r b"><span>ИТОГО</span><span>${money(s.total)}</span></div>
    ${s.payments.map(p => `<div class="r"><span>${PAY[p.method] || p.method}</span><span>${num(p.amount)}</span></div>`).join('')}
    ${s.bonus_earned ? `<div class="r"><span>Начислено бонусов</span><span>${num(s.bonus_earned)}</span></div>` : ''}
    ${s.comment ? `<hr><div>${esc(s.comment)}</div>` : ''}<hr><p>Спасибо за покупку!</p>
    <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)}<\/script></body></html>`);
  w.document.close();
}

// ================= ПРОДАЖИ =================
const SL = { period: 'today', status: 'completed', page: 1, num: '', from: '', to: '' };
async function viewSales(v) {
  const r = rangeOf(SL);
  const [res, clients, sellers, sum] = await Promise.all([
    api('/api/sales' + qs({ store_id: S.stores.length > 1 ? S.storeId : '', status: SL.status, number: SL.num, date_from: SL.num ? '' : r.from, date_to: SL.num ? '' : r.to, page: SL.page, size: 50 })),
    can('clients.read') ? api('/api/clients' + qs({ size: 500 })) : { items: [] },
    can('sales.create') ? api('/api/sales/sellers') : [],
    can('reports.read') ? api('/api/reports/dashboard' + qs({ date_from: r.from, date_to: r.to, store_id: S.stores.length > 1 ? S.storeId : '' })) : null,
  ]);
  const cn = Object.fromEntries(clients.items.map(c => [c.id, c.name]));
  const sn = Object.fromEntries(sellers.map(s => [s.id, s.name]));
  const t = sum?.transactions, p = sum?.payments;
  const side = sum ? `<aside class="aside grid" style="align-content:start">
    ${can('reports.read') ? '<button class="btn" data-a="xreport">Распечатать отчёт за период</button>' : ''}
    <section class="panel"><h2>Транзакции: ${t.count}</h2>
      <div class="tbl-wrap"><table><tbody>
        <tr><td>Товары</td><td class="r">${num(t.goods_qty)} шт</td></tr><tr><td>Услуги</td><td class="r">${num(t.services_qty)} шт</td></tr>
        <tr><td>Возвраты</td><td class="r">${t.returns_count} · ${money(t.returns_amount)}</td></tr>
        <tr><td>Обмены</td><td class="r">${t.exchanges_count} · ${money(t.exchanges_amount)}</td></tr>
        <tr><td>Средний чек</td><td class="r">${money(t.average_check)}</td></tr></tbody></table></div></section>
    <section class="panel"><h2>Сумма транзакций</h2><b style="font-size:26px" class="num">${money(sum.revenue.gross)}</b>
      <div class="tbl-wrap" style="margin-top:8px"><table><tbody>
        <tr><td>Наличные</td><td class="r">${money(p.cash)}</td></tr><tr><td>Карта</td><td class="r">${money(p.card)}</td></tr>
        <tr><td>В долг</td><td class="r ${p.debt ? 'bad' : ''}">${money(p.debt)}</td></tr>${p.bonus ? `<tr><td>Бонусами</td><td class="r">${money(p.bonus)}</td></tr>` : ''}
        ${p.exchange ? `<tr><td>Зачёт по обменам</td><td class="r">${money(p.exchange)}</td></tr>` : ''}
        <tr><td><b>Чистая выручка</b></td><td class="r"><b>${money(sum.revenue.net)}</b></td></tr></tbody></table></div></section></aside>` : '';
  v.innerHTML = `<div class="head"><div><h1>Продажи</h1><p class="sub">${res.total} ${plural(res.total, 'чек', 'чека', 'чеков')} · ${fRange(r)}</p></div>
    ${can('sales.create') ? '<a class="btn" href="#kassa">Новая продажа</a>' : ''}</div>
  <div class="row"><div class="grow panel"><div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
    ${rangeControls(SL, ['today', 'week', 'month', 'year'])}
    <select class="input" id="slStatus" style="width:auto"><option value="completed" ${SL.status === 'completed' ? 'selected' : ''}>Проведённые</option><option value="held" ${SL.status === 'held' ? 'selected' : ''}>Отложенные</option><option value="cancelled" ${SL.status === 'cancelled' ? 'selected' : ''}>Отменённые</option><option value="return" ${SL.status === 'return' ? 'selected' : ''}>Возвраты из BILLZ</option></select>
    <input class="input" id="slNum" type="number" placeholder="№ чека" value="${esc(SL.num)}" style="width:130px" aria-label="Номер чека"></div>
    ${res.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>№</th><th>Дата</th><th>Клиент</th><th>Продавец</th><th>Товары</th><th>Оплата</th><th class="r">Сумма</th></tr></thead><tbody>
      ${res.items.map(s => `<tr class="click" data-sale="${s.id}" tabindex="0"><td class="num">${s.number}${s.exchange_of_id ? ' <span class="tag grey">обмен</span>' : ''}</td><td>${fDateTime(s.created_at)}</td><td>${esc(cn[s.client_id] || (s.client_id ? 'Клиент' : '—'))}</td>
        <td>${esc(sn[s.seller_id] || '—')}</td><td>${esc(s.items.map(i => i.name).slice(0, 2).join(', '))}${s.items.length > 2 ? ` +${s.items.length - 2}` : ''}</td>
        <td>${s.payments.map(p => `<span class="tag ${PAY_TAG[p.method] ?? 'grey'}">${PAY[p.method] || p.method}</span>`).join(' ') || '<span class="tag grey">не оплачен</span>'}</td>
        <td class="r"><b>${money(s.total)}</b>${s.returned_total ? `<br><small class="bad">возврат ${num(s.returned_total)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${pager(res.total, SL.page, 50)}` : '<p class="empty">За выбранный период продаж нет.</p>'}</div>${side}</div>`;
  v.onclick = e => {
    if (rangeEvent(SL, e)) { SL.page = 1; route(); return; }
    const pg = e.target.closest('[data-page]'); if (pg) { SL.page = +pg.dataset.page; route(); return; }
    if (e.target.closest('[data-a=xreport]')) { printPeriodReport(sum, r); return; }
    const tr = e.target.closest('[data-sale]'); if (tr) saleModal(res.items.find(s => s.id === +tr.dataset.sale), cn, sn);
  };
  v.onkeydown = e => { const tr = e.target.closest('[data-sale]'); if (tr && e.key === 'Enter') tr.click(); };
  v.onchange = e => { if (rangeEvent(SL, e)) { SL.page = 1; route(); return; } if (e.target.id === 'slStatus') { SL.status = e.target.value; SL.page = 1; route(); } if (e.target.id === 'slNum') { SL.num = e.target.value; route(); } };
}
function printPeriodReport(d, r) {
  const w = window.open('', '_blank', 'width=420,height=700');
  if (!w) { toast('Браузер заблокировал окно печати. Разрешите всплывающие окна для этого сайта', true); return; }
  const t = d.transactions, p = d.payments, row = (a, b) => `<div class="r"><span>${a}</span><span>${b}</span></div>`;
  w.document.write(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт за период</title><style>
    body{font:13px/1.5 "IBM Plex Mono",ui-monospace,monospace;margin:0;padding:16px;width:300px}h1{font-size:16px;text-align:center;margin:0}
    p{text-align:center;margin:0}.r{display:flex;justify-content:space-between}hr{border:0;border-top:1px dashed #000;margin:8px 0}b{font-size:15px}</style></head><body>
    <h1>${esc(S.company.name)}</h1><p>Отчёт: ${fRange(r)}</p><p>Распечатан ${new Date().toLocaleString('ru-RU')}</p><hr>
    ${row('Чеков', t.count)}${row('Товаров, шт', num(t.goods_qty))}${row('Услуг, шт', num(t.services_qty))}${row('Средний чек', num(t.average_check))}<hr>
    ${row('Наличные', num(p.cash))}${row('Карта', num(p.card))}${row('В долг', num(p.debt))}${p.bonus ? row('Бонусами', num(p.bonus)) : ''}${p.exchange ? row('Зачёт обменов', num(p.exchange)) : ''}<hr>
    ${row('Продажи', num(d.revenue.gross))}${row(`Возвраты (${t.returns_count})`, '−' + num(t.returns_amount))}${row(`Обмены (${t.exchanges_count})`, num(t.exchanges_amount))}
    <hr><div class="r"><b>Чистая выручка</b><b>${money(d.revenue.net)}</b></div>
    <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)}<\/script></body></html>`);
  w.document.close();
}
const pager = (total, page, size) => total <= size ? '' : `<div class="pager"><span>${(page - 1) * size + 1}–${Math.min(total, page * size)} из ${total}</span>
  <button class="btn ghost sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Назад</button><button class="btn ghost sm" data-page="${page + 1}" ${page * size >= total ? 'disabled' : ''}>Дальше</button></div>`;
async function saleModal(s, cn = {}, sn = {}) {
  const returns = s.status === 'completed' ? await api(`/api/sales/${s.id}/returns`) : [];
  const client = s.client_id ? await api(`/api/clients/${s.client_id}`).catch(() => null) : null;
  const canRet = can('sales.return') && s.status === 'completed' && s.items.some(i => i.qty > i.returned_qty);
  const RM = { cash: 'наличными', card: 'на карту', debt: 'в счёт долга', exchange: 'обмен', 'exchange+cash': 'обмен, разница наличными', 'exchange+card': 'обмен, разница на карту', 'debt+cash': 'в счёт долга и наличными' };
  const m = modal(`Чек №${s.number}`, `<p class="sub" style="margin-top:-8px">${fDateTime(s.created_at)}${client ? ` · ${esc(client.name)}` : ''}${sn[s.seller_id] ? ` · продавец ${esc(sn[s.seller_id])}` : ''}</p>
    ${s.comment ? `<p class="note">${esc(s.comment)}</p>` : ''}
    <form class="form" id="retForm"><div class="tbl-wrap"><table><thead><tr><th>Товар</th><th class="r">Кол-во</th><th class="r">Цена</th><th class="r">Скидка</th><th class="r">Сумма</th>${canRet ? '<th class="r">Вернуть</th>' : ''}</tr></thead><tbody>
    ${s.items.map(i => `<tr><td>${esc(i.name)}${i.returned_qty ? `<br><small class="bad">возвращено ${num(i.returned_qty)}</small>` : ''}</td><td class="r">${num(i.qty)}</td><td class="r">${num(i.price)}</td><td class="r">${i.discount ? '−' + num(i.discount) : ''}</td><td class="r"><b>${num(i.total)}</b></td>
      ${canRet ? `<td class="r">${i.qty > i.returned_qty ? `<input class="input num" style="width:80px;min-height:36px" type="number" min="0" max="${i.qty - i.returned_qty}" step="1" name="r${i.id}" value="0" aria-label="Вернуть ${esc(i.name)}">` : ''}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>
    <div class="mono" style="display:grid;gap:4px;font-size:14px">
      ${s.discount ? `<div style="display:flex;justify-content:space-between"><span>Скидка</span><span>−${num(s.discount)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-weight:600"><span>Итого</span><span>${money(s.total)}</span></div>
      ${s.payments.map(p => `<div style="display:flex;justify-content:space-between" class="muted"><span>${PAY[p.method] || p.method}</span><span>${num(p.amount)}</span></div>`).join('')}
      ${s.bonus_earned ? `<div style="display:flex;justify-content:space-between" class="muted"><span>Начислено бонусов</span><span>${num(s.bonus_earned)}</span></div>` : ''}
      ${returns.map(r => `<div style="display:flex;justify-content:space-between" class="bad"><span>${r.refund_method.startsWith('exchange') ? 'Обмен' : 'Возврат'} ${fDateTime(r.created_at)} (${RM[r.refund_method] || r.refund_method})</span><span>−${num(r.amount)}</span></div>`).join('')}</div>
    ${canRet ? `<div class="two">${field('Как вернуть деньги', `<select class="input" name="refund_method"><option value="cash">Наличными</option><option value="card">На карту</option>${s.client_id ? '<option value="debt">Уменьшить долг клиента</option>' : ''}</select>`)}${field('Причина', inp('reason', { ph: 'Например, брак' }))}</div>
      <div class="err" hidden></div>
      <div class="modal-f" style="margin-top:0">${can('sales.create') ? '<button class="btn ghost" type="button" data-exch>Обменять выбранное</button>' : ''}<button class="btn danger" type="submit">Оформить возврат</button></div>` : ''}
    <div class="modal-f" style="margin-top:0"><button class="btn ghost" type="button" data-printsale>Печать чека</button></div></form>`, { wide: true });
  const f = $('#retForm', m.el), err = () => $('.err', f);
  const picked = () => { const d = Object.fromEntries(new FormData(f)); return { d, items: s.items.map(i => ({ i, qty: +(d['r' + i.id] || 0) })).filter(x => x.qty > 0) }; };
  $('[data-printsale]', m.el).onclick = () => printReceipt(s);
  const ex = $('[data-exch]', m.el);
  if (ex) ex.onclick = () => {
    const { items } = picked();
    if (!items.length) { err().textContent = 'Отметьте в колонке «Вернуть», какие товары клиент меняет'; err().hidden = false; return; }
    m.close();
    startExchange(s, items.map(({ i, qty }) => ({ sale_item_id: i.id, qty, name: i.name, amount: Math.round(i.total * qty / i.qty * 100) / 100 })), client);
    toast('Выберите новые товары на кассе — сумма возврата пойдёт в зачёт');
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const { d, items } = picked();
    if (!items.length) { err().textContent = 'Укажите, сколько штук вернуть'; err().hidden = false; return; }
    try { const r = await api(`/api/sales/${s.id}/returns`, { method: 'POST', body: { items: items.map(x => ({ sale_item_id: x.i.id, qty: x.qty })), refund_method: d.refund_method, reason: d.reason || null } });
      m.close(); toast(`Возврат оформлен: ${money(r.amount)}${r.refund_method === 'debt+cash' ? '. Часть сверх долга отдайте наличными' : ''}`); route(); }
    catch (x) { err().textContent = x.message; err().hidden = false; }
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
    <label class="search" style="flex:1 1 280px">${ICON.search}<input id="pq" placeholder="Название, артикул или штрихкод" value="${esc(P.q)}" aria-label="Поиск"></label>
    <select class="input" id="pcat" style="width:auto">${opts(S.cats, P.cat, 'id', 'name', 'Все категории')}</select></div>
    ${res.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Название</th><th>Артикул</th><th>Штрихкод</th><th>Категория</th><th class="r">Цена</th><th class="r">Себестоимость</th><th class="r">Остаток</th></tr></thead><tbody>
    ${res.items.map(p => { const st = stockOf(p), ed = can('products.write'), ce = (f, v, ph = '—') => ed ? `<span class="cell-edit" data-edit="${f}" data-id="${p.id}" title="Нажмите, чтобы изменить">${v || ph}</span>` : (v || ph); return `<tr class="click" data-p="${p.id}" tabindex="0"><td><b>${ce('name', esc(p.name))}</b>${p.is_active ? '' : ' <span class="tag grey">выключен</span>'}</td><td>${esc(p.sku || '—')}</td><td>${ce('barcode', esc(p.barcode || ''))}</td><td>${esc(cn[p.category_id] || '—')}</td>
      <td class="r">${ed && can('stock.manage') ? `<span class="cell-edit" data-edit="price" data-id="${p.id}" title="Нажмите, чтобы изменить цену">${money(p.retail_price)}</span>` : money(p.retail_price)}</td><td class="r muted">${num(p.cost_price)}</td>
      <td class="r">${p.is_service ? '<span class="tag grey">услуга</span>' : `<span class="tag ${st <= 0 ? 'red' : st <= +S.company.low_stock_threshold ? 'amber' : 'green'}">${num(st)} ${esc(p.unit)}</span>`}</td></tr>`; }).join('')}
    </tbody></table></div>${pager(res.total, P.page, 50)}`
    : `<p class="empty">${stats.all ? 'По этому фильтру товаров нет.' : 'Каталог пустой. Добавьте первый товар или загрузите список из CSV.'}</p>`}</div>`;
  const reload = debounce(() => { P.page = 1; route(); }, 350);
  v.oninput = e => { if (e.target.id === 'pq') { P.q = e.target.value; reload(); } };
  v.onchange = e => { if (e.target.id === 'pcat') { P.cat = e.target.value; P.page = 1; route(); } };
  v.onkeydown = e => { const tr = e.target.closest('[data-p]'); if (tr && e.key === 'Enter' && e.target === tr) tr.click(); };
  v.onclick = e => {
    const ce = e.target.closest('.cell-edit');
    if (ce) { e.stopPropagation(); inlineEdit(ce, res.items.find(p => p.id === +ce.dataset.id)); return; }
    if (e.target.closest('.cell-input')) return;
    const t = e.target.closest('[data-status],[data-page],[data-p],[data-a]'); if (!t) return;
    if (t.dataset.status) { P.status = t.dataset.status; P.page = 1; route(); }
    else if (t.dataset.page) { P.page = +t.dataset.page; route(); }
    else if (t.dataset.p) productModal(res.items.find(p => p.id === +t.dataset.p));
    else if (t.dataset.a === 'new') productModal(null);
    else if (t.dataset.a === 'stockin') stockInModal();
    else if (t.dataset.a === 'import') importModal();
  };
}
// правка прямо в ячейке: Enter — сохранить, Esc — отменить
function inlineEdit(span, p) {
  const f = span.dataset.edit, old = f === 'price' ? p.retail_price : (p[f] || '');
  const input = document.createElement('input');
  input.className = 'cell-input'; input.value = old; input.setAttribute('aria-label', { name: 'Название', barcode: 'Штрихкод', price: 'Цена' }[f]);
  if (f === 'price') { input.type = 'number'; input.step = '0.01'; input.min = '0'; }
  span.replaceWith(input); input.focus(); input.select();
  let busy = false;
  const finish = async save => {
    if (busy) return; busy = true;
    const val = input.value.trim();
    if (!save || String(val) === String(old) || (f === 'name' && !val)) { input.replaceWith(span); return; }
    input.disabled = true;
    try {
      if (f === 'price') {
        const doc = await api('/api/stock/repricing', { method: 'POST', body: { items: [{ product_id: p.id, price: nOrNull(val) }] } });
        await api(`/api/stock/repricing/${doc.id}/complete`, { method: 'POST' });
        p.retail_price = nOrNull(val); span.textContent = money(p.retail_price);
      } else {
        const r = await api(`/api/products/${p.id}`, { method: 'PATCH', body: { [f]: val || null } });
        p[f] = r[f]; span.textContent = r[f] || '—';
      }
      input.replaceWith(span);
      const tr = span.closest('tr'); tr.classList.remove('saved'); void tr.offsetWidth; tr.classList.add('saved');
      toast(f === 'price' ? `Новая цена ${money(p.retail_price)} — сохранено в истории переоценок` : 'Сохранено');
    } catch (x) { toast(x.message, true); input.disabled = false; busy = false; input.focus(); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(e.key === 'Enter'); } });
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
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
    ${field('Оптовая цена (необязательно)', inp('wholesale_price', { type: 'number', step: '0.01', min: 0, value: p?.wholesale_price ?? '', ph: 'Если пусто — продаётся по рознице' }))}
    <div class="two">${field('Единица', inp('unit', { value: p?.unit || 'шт' }))}${isNew ? field('Начальный остаток', inp('qty', { type: 'number', step: '1', min: 0, ph: '0' })) : '<span></span>'}</div>
    <label class="check"><input type="checkbox" name="is_service" ${p?.is_service ? 'checked' : ''}> Это услуга (без остатка на складе)</label>
    ${!isNew ? `<label class="check"><input type="checkbox" name="is_active" ${p.is_active ? 'checked' : ''}> Продаётся (виден на кассе)</label>` : ''}
    ${!isNew ? `<p class="note" style="margin:0">Изменение розничной цены сохраняется как переоценка — с историей.</p>` : ''}`;
  const history = p ? `<h2 style="margin-top:20px;font-size:16px">Движение товара в этом магазине</h2>${moves.length ? `<div class="tbl-wrap"><table><tbody>${moves.map(mv => `<tr><td>${fDateTime(mv.created_at)}</td><td>${REASON[mv.reason] || mv.reason}</td><td class="r ${mv.delta < 0 ? 'bad' : 'good'}">${mv.delta > 0 ? '+' : ''}${num(mv.delta)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Движений пока не было.</p>'}` : '';
  if (!edit) { modal(p.name, `<p>Цена: <b>${money(p.retail_price)}</b>. Остаток: <b>${num(stockOf(p))} ${esc(p.unit)}</b></p>${history}`, { wide: true }); return; }
  formModal(isNew ? 'Новый товар' : p.name, fields, async (d, m) => {
    const category_id = await ensureCategory(d);
    const base = { name: d.name, sku: d.sku || null, barcode: d.barcode || null, category_id, unit: d.unit || 'шт', is_service: !!d.is_service, cost_price: nOrNull(d.cost_price) ?? 0, wholesale_price: nOrNull(d.wholesale_price) };
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
  const [res, stats, groups] = await Promise.all([
    api('/api/clients' + qs({ q: C.q, has_debt: C.debt, page: C.page, size: 50 })), api('/api/clients/stats'), api('/api/client-groups')]);
  const gn = Object.fromEntries(groups.map(g => [g.id, g.name]));
  v.innerHTML = `<div class="head"><div><h1>Клиенты</h1><p class="sub">База покупателей, их покупки, бонусы и долги</p></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${can('marketing.manage') ? '<button class="btn ghost" data-a="groups">Группы и скидки</button>' : ''}<a class="btn ghost" href="#debts">Долги клиентов</a>${can('clients.write') ? '<button class="btn" data-a="new">Новый клиент</button>' : ''}</div></div>
  <div class="kpis">
    <div class="kpi"><span>Всего клиентов</span><b>${stats.total}</b></div>
    <div class="kpi"><span>Новые за неделю</span><b class="${stats.new_week ? 'good' : ''}">+${stats.new_week}</b></div>
    <div class="kpi"><span>Не возвращаются</span><b class="${stats.not_returning ? 'warn' : ''}">${stats.not_returning}</b><small class="muted">не покупали 60+ дней</small></div>
    <div class="kpi"><span>Дни рождения</span><b>${stats.birthdays}</b><small class="muted">в ближайшие 7 дней</small></div></div>
  <div class="panel"><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px">
    <label class="search" style="flex:1 1 280px">${ICON.search}<input id="cq" placeholder="Имя или телефон" value="${esc(C.q)}" aria-label="Поиск клиента"></label>
    <label class="check"><input type="checkbox" id="cdebt" ${C.debt ? 'checked' : ''}> Только должники</label></div>
    ${res.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Имя</th><th>Телефон</th><th>Группа</th><th>Пол</th><th class="r">Покупки</th><th class="r">Последняя</th><th class="r">Бонусы</th><th class="r">Долг</th></tr></thead><tbody>
    ${res.items.map(c => `<tr class="click" data-c="${c.id}" tabindex="0"><td><b>${esc(c.name)}</b> ${(c.tags || []).map(t => `<span class="tag grey">${esc(t)}</span>`).join(' ')}</td><td>${esc(c.phone || '—')}</td><td>${esc(gn[c.group_id] || '—')}</td>
      <td>${{ m: 'Муж.', f: 'Жен.' }[c.gender] || '—'}</td><td class="r">${c.purchases_count ? `${money(c.purchases_total)}<br><small class="muted">${c.purchases_count} ${plural(c.purchases_count, 'покупка', 'покупки', 'покупок')}</small>` : '—'}</td>
      <td class="r">${c.last_purchase ? fDateTime(c.last_purchase).slice(0, 8) : '—'}</td>
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
    <div class="two">${field('Пол', `<select class="input" name="gender"><option value="">Не указан</option><option value="m" ${c?.gender === 'm' ? 'selected' : ''}>Мужской</option><option value="f" ${c?.gender === 'f' ? 'selected' : ''}>Женский</option></select>`)}
      ${field('Группа', `<select class="input" name="group_id">${opts(groups.map(g => ({ ...g, name: `${g.name}${+g.discount_percent ? ` (−${num(g.discount_percent)}%)` : ''}` })), c?.group_id, 'id', 'name', 'Без группы')}</select>`)}</div>
    ${field('Теги через запятую', inp('tags', { value: (c?.tags || []).join(', '), ph: 'опт, постоянный' }))}
    ${field('Заметка', `<textarea class="input" name="note">${esc(c?.note || '')}</textarea>`)}
    <label class="check"><input type="checkbox" name="sms_allowed" ${c?.sms_allowed ?? true ? 'checked' : ''}> Согласен получать SMS</label>`,
  async (d, m) => {
    const body = { name: d.name, phone: d.phone || null, birth_date: d.birth_date || null, group_id: nOrNull(d.group_id), note: d.note || null, gender: d.gender || null,
      tags: d.tags.split(',').map(s => s.trim()).filter(Boolean), sms_allowed: !!d.sms_allowed };
    const r = c ? await api(`/api/clients/${c.id}`, { method: 'PATCH', body }) : await api('/api/clients', { method: 'POST', body });
    m.close(); toast(c ? 'Клиент сохранён' : `Клиент «${r.name}» добавлен`); done?.(r);
  }, { submit: c ? 'Сохранить' : 'Добавить клиента' });
}
async function clientCard(c, groups = []) {
  const [sales, debts] = await Promise.all([api(`/api/clients/${c.id}/sales`), api('/api/debts' + qs({ q: c.phone || c.name, size: 100 }))]);
  const myDebts = debts.items.filter(d => d.client_id === c.id);
  const m = modal(c.name, `<div class="kpis" style="margin-bottom:16px">
      <div class="kpi" style="background:var(--bg)"><span>Покупок</span><b>${c.purchases_count}</b><small class="muted">на ${money(c.purchases_total)}</small></div>
      <div class="kpi" style="background:var(--bg)"><span>Бонусы</span><b>${num(c.bonus_balance)}</b></div>
      <div class="kpi" style="background:var(--bg)"><span>Долг</span><b class="${+c.debt_balance ? 'bad' : ''}">${money(c.debt_balance)}</b></div></div>
    <p class="sub" style="margin:0 0 12px">${esc(c.phone || 'Телефон не указан')}${c.group_id ? ` · ${esc(groups.find(g => g.id === c.group_id)?.name || '')}` : ''}${c.birth_date ? ` · ДР ${fDay(c.birth_date)}` : ''}${c.note ? `<br>${esc(c.note)}` : ''}</p>
    ${+c.debt_balance && can('clients.write') ? `<form class="form panel" id="payDebt" style="background:var(--bg);margin-bottom:16px"><h2 style="font-size:16px">Принять оплату долга</h2>
      <div class="two">${field('Сумма', inp('amount', { type: 'number', step: '0.01', min: 0, value: c.debt_balance, req: true }))}${field('Способ', '<select class="input" name="method"><option value="cash">Наличные</option><option value="card">Карта</option></select>')}</div>
      <div class="err" hidden></div><button class="btn" type="submit">Принять оплату</button></form>` : ''}
    ${myDebts.length ? `<h2 style="font-size:16px">Долги</h2><div class="tbl-wrap"><table><tbody>${myDebts.map(d => `<tr><td>${d.sale_number ? `Чек №${d.sale_number}` : esc(d.note || 'Долг')}<br><small class="muted">до ${d.due_date ? fDay(d.due_date) : '—'}</small></td><td>${debtTag(d.status)}</td><td class="r">${money(d.left)}<br><small class="muted">из ${num(d.amount)}</small></td></tr>`).join('')}</tbody></table></div>` : ''}
    <h2 style="font-size:16px;margin-top:16px">Последние покупки</h2>${sales.length ? `<div class="tbl-wrap"><table><tbody>${sales.slice(0, 10).map(s => `<tr><td>№${s.number}</td><td>${fDateTime(s.created_at)}</td><td>${s.payments.map(p => `<span class="tag ${PAY_TAG[p.method] ?? 'grey'}">${PAY[p.method] || p.method}</span>`).join(' ')}</td><td class="r"><b>${money(s.total)}</b></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Покупок пока нет.</p>'}
    <div class="modal-f"><button class="btn ghost" data-act>Акт сверки</button>${can('clients.write') ? '<button class="btn ghost" data-edit>Изменить</button>' : ''}<button class="btn" data-close>Закрыть</button></div>`, { wide: true });
  $('[data-edit]', m.el)?.addEventListener('click', () => { m.close(); clientModal(c, () => route()); });
  $('[data-act]', m.el).onclick = () => statementModal(c);
  const f = $('#payDebt', m.el);
  if (f) f.onsubmit = async e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    try { await api(`/api/clients/${c.id}/debt-payments`, { method: 'POST', body: { amount: nOrNull(d.amount), method: d.method, store_id: S.storeId } }); m.close(); toast(`Оплата долга принята: ${money(d.amount)}`); route(); }
    catch (x) { const err = $('.err', f); err.textContent = x.message; err.hidden = false; }
  };
}
function statementModal(c) {
  formModal(`Акт сверки: ${c.name}`, `<div class="two">${field('С', inp('from', { type: 'date', value: iso(addDays(new Date(), -89)) }))}${field('По', inp('to', { type: 'date', value: today() }))}</div>`,
  async (d, m) => {
    const st = await api(`/api/clients/${c.id}/statement` + qs({ date_from: d.from, date_to: d.to }));
    m.close();
    const w = window.open('', '_blank', 'width=760,height=800');
    if (!w) throw new Error('Браузер заблокировал окно печати');
    w.document.write(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Акт сверки — ${esc(c.name)}</title><style>
      body{font:14px/1.5 Onest,system-ui,sans-serif;margin:32px;color:#131A2C}h1{font-size:22px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:16px 0}
      th,td{border-bottom:1px solid #ccc;padding:6px 8px;text-align:left}td.r,th.r{text-align:right}tfoot td{font-weight:700}.sign{display:flex;justify-content:space-between;margin-top:48px}</style></head><body>
      <h1>Акт сверки взаиморасчётов</h1><p>${esc(S.company.name)} и ${esc(c.name)}${c.phone ? `, ${esc(c.phone)}` : ''}<br>Период: ${fDay(d.from)}.${d.from.slice(0, 4)} — ${fDay(d.to)}.${d.to.slice(0, 4)}</p>
      <table><thead><tr><th>Дата</th><th>Операция</th><th class="r">Долг +</th><th class="r">Оплата −</th></tr></thead><tbody>
      <tr><td></td><td>Долг на начало периода</td><td class="r" colspan="2">${money(st.opening)}</td></tr>
      ${st.rows.map(r => `<tr><td>${fDateTime(r.date)}</td><td>${esc(r.title)}</td><td class="r">${r.debit ? num(r.debit) : ''}</td><td class="r">${r.credit ? num(r.credit) : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td></td><td>Обороты за период</td><td class="r">${num(st.debit)}</td><td class="r">${num(st.credit)}</td></tr>
      <tr><td></td><td>Долг на конец периода</td><td class="r" colspan="2">${money(st.closing)}</td></tr></tfoot></table>
      <div class="sign"><span>${esc(S.company.name)} ____________</span><span>${esc(c.name)} ____________</span></div>
      <script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  }, { submit: 'Сформировать и распечатать' });
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

// ================= ДОЛГИ =================
const DEBT_ST = { overdue: ['Просрочен', 'red'], unpaid: ['Не погашен', 'amber'], partial: ['Частично', ''], paid: ['Погашен', 'green'] };
const debtTag = s => `<span class="tag ${DEBT_ST[s]?.[1] ?? 'grey'}">${DEBT_ST[s]?.[0] || s}</span>`;
const DB = { tab: 'debts', status: 'all', q: '', page: 1, sel: new Set() };
async function viewDebts(v) {
  const isPay = DB.tab === 'payments';
  const data = isPay ? await api('/api/debts/payments' + qs({ q: DB.q, page: DB.page, size: 50 }))
    : await api('/api/debts' + qs({ status: DB.status, q: DB.q, page: DB.page, size: 50 }));
  const sum = isPay ? null : data.summary;
  const all = isPay ? null : await api('/api/debts' + qs({ size: 1 }));
  const sm = (sum && DB.status === 'all' && !DB.q) ? sum : all?.summary;
  const w = can('clients.write');
  v.innerHTML = `<div class="head"><div><h1>Долги клиентов</h1><p class="sub">${sm ? `${sm.debtors} ${plural(sm.debtors, 'должник', 'должника', 'должников')}, к получению ${money(sm.left)}${sm.overdue_sum ? `, из них просрочено <b class="bad">${money(sm.overdue_sum)}</b>` : ''}` : 'Все принятые оплаты долгов'}</p></div>
    <div class="seg"><button data-tab="debts" class="${!isPay ? 'on' : ''}">Долги</button><button data-tab="payments" class="${isPay ? 'on' : ''}">Погашения</button></div></div>
  ${sm ? `<div class="kpis"><div class="kpi"><span>Сумма долгов</span><b>${money(sm.total)}</b></div><div class="kpi"><span>Погашено</span><b class="good">${money(sm.paid)}</b></div>
    <div class="kpi"><span>Остаток долгов</span><b class="${sm.left ? 'bad' : ''}">${money(sm.left)}</b></div><div class="kpi"><span>Просрочено</span><b class="${sm.overdue ? 'bad' : ''}">${sm.overdue}</b><small class="muted">${plural(sm.overdue, 'долг', 'долга', 'долгов')}</small></div></div>` : ''}
  <div class="panel"><div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
    ${isPay ? '' : `<div class="chips">${[['all', 'Все'], ['overdue', 'Просроченные'], ['unpaid', 'Непогашенные'], ['partial', 'Частично'], ['paid', 'Погашенные']].map(([k, t]) => `<button class="chip ${DB.status === k ? 'on' : ''}" data-st="${k}">${t}${k !== 'all' && sm ? `<small>${sm[k]}</small>` : ''}</button>`).join('')}</div>`}
    <label class="search" style="flex:1 1 220px">${ICON.search}<input id="dq" placeholder="Клиент или телефон" value="${esc(DB.q)}" aria-label="Поиск"></label>
    ${!isPay && w ? `<button class="btn" data-mass ${DB.sel.size ? '' : 'disabled'}>Погасить выбранные${DB.sel.size ? ` (${DB.sel.size})` : ''}</button>` : ''}</div>
  ${isPay ? (data.items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Дата</th><th>Клиент</th><th>Способ</th><th class="r">Сумма</th></tr></thead><tbody>${data.items.map(p => `<tr><td>${fDateTime(p.created_at)}</td><td>${esc(p.client_name)}</td><td>${p.method === 'return' ? '<span class="tag grey">возврат товара</span>' : PAY[p.method] || p.method}</td><td class="r good"><b>${money(p.amount)}</b></td></tr>`).join('')}</tbody></table></div>${pager(data.total, DB.page, 50)}` : '<p class="empty">Погашений пока не было.</p>')
    : data.items.length ? `<div class="tbl-wrap"><table><thead><tr>${w ? '<th></th>' : ''}<th>Клиент</th><th>Чек</th><th>Выдан</th><th>Вернуть до</th><th>Статус</th><th class="r">Сумма</th><th class="r">Остаток</th>${w ? '<th></th>' : ''}</tr></thead><tbody>
      ${data.items.map(d => `<tr>${w ? `<td>${d.status !== 'paid' ? `<input type="checkbox" data-sel="${d.id}" ${DB.sel.has(d.id) ? 'checked' : ''} aria-label="Выбрать долг" style="width:20px;height:20px;accent-color:var(--blue)">` : ''}</td>` : ''}
        <td><b>${esc(d.client_name)}</b><br><small class="muted">${esc(d.client_phone || '')}</small></td><td>${d.sale_number ? `№${d.sale_number}` : esc(d.note || '—')}</td><td>${fDateTime(d.created_at).slice(0, 8)}</td>
        <td class="${d.status === 'overdue' ? 'bad' : ''}">${d.due_date ? fDay(d.due_date) + '.' + d.due_date.slice(2, 4) : '—'}</td><td>${debtTag(d.status)}</td><td class="r">${money(d.amount)}</td><td class="r"><b>${money(d.left)}</b></td>
        ${w ? `<td class="r">${d.status !== 'paid' ? `<button class="btn sm" data-pay="${d.id}">Погасить</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>${pager(data.total, DB.page, 50)}`
      : '<p class="empty">Долгов нет.</p>'}</div>`;
  v.oninput = debounce(e => { if (e.target.id === 'dq') { DB.q = e.target.value; DB.page = 1; route(); } }, 350);
  v.onchange = e => { const id = e.target.dataset.sel; if (id) { e.target.checked ? DB.sel.add(+id) : DB.sel.delete(+id); const b = $('[data-mass]', v); if (b) { b.disabled = !DB.sel.size; b.textContent = `Погасить выбранные${DB.sel.size ? ` (${DB.sel.size})` : ''}`; } } };
  v.onclick = async e => {
    const t = e.target.closest('[data-tab],[data-st],[data-page],[data-pay],[data-mass]'); if (!t) return;
    if (t.dataset.tab) { DB.tab = t.dataset.tab; DB.page = 1; route(); }
    else if (t.dataset.st) { DB.status = t.dataset.st; DB.page = 1; route(); }
    else if (t.dataset.page) { DB.page = +t.dataset.page; route(); }
    else if (t.dataset.pay) {
      const d = data.items.find(x => x.id === +t.dataset.pay);
      formModal(`Погасить долг: ${d.client_name}`, `<p class="sub" style="margin:0">${d.sale_number ? `Чек №${d.sale_number}, ` : ''}остаток ${money(d.left)}</p>
        <div class="two">${field('Сумма', inp('amount', { type: 'number', step: '0.01', min: 0, value: d.left, req: true }))}${field('Способ', '<select class="input" name="method"><option value="cash">Наличные</option><option value="card">Карта</option></select>')}</div>`,
      async (f, m) => {
        await api(`/api/clients/${d.client_id}/debt-payments`, { method: 'POST', body: { amount: nOrNull(f.amount), method: f.method, debt_ids: [d.id], store_id: S.storeId } });
        m.close(); toast(`Принято ${money(f.amount)}`); route();
      }, { submit: 'Принять оплату' });
    } else if ('mass' in t.dataset) {
      const ids = [...DB.sel], picked = data.items.filter(x => DB.sel.has(x.id)), total = picked.reduce((a, x) => a + x.left, 0);
      formModal('Массовое погашение', `<p class="sub" style="margin:0">${ids.length} ${plural(ids.length, 'долг', 'долга', 'долгов')} будут погашены полностью на сумму ${money(total)}.</p>
        ${field('Способ оплаты', '<select class="input" name="method"><option value="cash">Наличные</option><option value="card">Карта</option></select>')}`,
      async (f, m) => { const r = await api('/api/debts/pay', { method: 'POST', body: { debt_ids: ids, method: f.method } }); DB.sel.clear(); m.close(); toast(`Погашено ${money(r.paid)}`); route(); },
      { submit: 'Погасить' });
    }
  };
}

// ================= ПОСТАВЩИКИ =================
async function viewSuppliers(v) {
  const sups = await api('/api/suppliers');
  const totalDebt = sups.reduce((a, s) => a + Math.max(0, s.debt), 0);
  v.innerHTML = `<div class="head"><div><h1>Поставщики</h1><p class="sub">${totalDebt ? `Мы должны поставщикам <b class="bad">${money(totalDebt)}</b>` : 'Долгов перед поставщиками нет'}</p></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost" data-a="pay" ${sups.length ? '' : 'disabled'}>Добавить оплату</button><button class="btn ghost" data-a="return" ${sups.length ? '' : 'disabled'}>Возврат поставщику</button><button class="btn" data-a="new">Новый поставщик</button></div></div>
  <div class="panel">${sups.length ? `<div class="tbl-wrap"><table><thead><tr><th>Поставщик</th><th>Телефон</th><th class="r">Сумма заказов</th><th class="r">Возвраты</th><th class="r">Оплачено</th><th class="r">Наш долг</th><th class="r">Товаров, шт</th></tr></thead><tbody>
    ${sups.map(s => `<tr class="click" data-s="${s.id}" tabindex="0"><td><b>${esc(s.name)}</b></td><td>${esc(s.phone || '—')}</td><td class="r">${money(s.orders_total)}</td><td class="r">${s.returns_total ? money(s.returns_total) : '—'}</td>
      <td class="r good">${money(s.paid_total)}</td><td class="r">${s.debt > 0 ? `<b class="bad">${money(s.debt)}</b>` : s.debt < 0 ? `<span class="good">переплата ${money(-s.debt)}</span>` : '—'}</td><td class="r">${num(s.items_count)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">Поставщиков пока нет. Их можно добавить здесь или при приходе товара.</p>'}</div>`;
  v.onkeydown = e => { const tr = e.target.closest('[data-s]'); if (tr && e.key === 'Enter') tr.click(); };
  v.onclick = e => {
    const t = e.target.closest('[data-s],[data-a]'); if (!t) return;
    if (t.dataset.s) supplierCard(sups.find(s => s.id === +t.dataset.s), sups);
    if (t.dataset.a === 'new') formModal('Новый поставщик', `${field('Название', inp('name', { req: true }))}${field('Телефон', inp('phone', { type: 'tel' }))}${field('Заметка', '<textarea class="input" name="note"></textarea>')}`,
      async (d, m) => { await api('/api/suppliers', { method: 'POST', body: { name: d.name, phone: d.phone || null, note: d.note || null } }); m.close(); toast('Поставщик добавлен'); route(); }, { submit: 'Добавить' });
    if (t.dataset.a === 'pay') supplierPayModal(sups, null);
    if (t.dataset.a === 'return') supplierReturnModal(sups);
  };
}
async function supplierPayModal(sups, sup) {
  const orders = sup ? await api('/api/stock/supplier_order' + qs({ supplier_id: sup.id, status: 'completed' })) : [];
  const unpaid = orders.filter(o => o.total > o.paid);
  formModal('Оплата поставщику', `
    ${field('Поставщик', `<select class="input" name="sid">${opts(sups, sup?.id)}</select>`)}
    ${unpaid.length ? field('За заказ (необязательно)', `<select class="input" name="doc"><option value="">Без привязки к заказу</option>${unpaid.map(o => `<option value="${o.id}">Заказ №${o.id} от ${fDateTime(o.created_at).slice(0, 8)} — осталось ${num(o.total - o.paid)}</option>`).join('')}</select>`) : ''}
    <div class="two">${field('Сумма', inp('amount', { type: 'number', step: '0.01', min: 0, req: true, value: sup && sup.debt > 0 ? sup.debt : '' }))}${field('Способ', '<select class="input" name="method"><option value="cash">Наличные</option><option value="card">Карта</option><option value="transfer">Перечисление</option></select>')}</div>
    ${field('Комментарий', inp('note'))}`,
  async (d, m) => {
    await api(`/api/suppliers/${d.sid}/payments`, { method: 'POST', body: { amount: nOrNull(d.amount), method: d.method, document_id: nOrNull(d.doc), note: d.note || null } });
    m.close(); toast(`Оплата ${money(d.amount)} записана`); route();
  }, { submit: 'Записать оплату' });
}
async function supplierReturnModal(sups) {
  const all = await api('/api/products' + qs({ status: 'active', size: 500, store_id: S.storeId }));
  const goods = all.items.filter(p => !p.is_service && stockOf(p) > 0);
  if (!goods.length) { toast('На складе нет товаров для возврата', true); return; }
  const row = () => `<div class="two srow" style="grid-template-columns:minmax(0,3fr) minmax(0,1fr) minmax(0,1fr) auto;align-items:end">
    ${field('Товар', `<select class="input" name="pid">${opts(goods.map(g => ({ ...g, name: `${g.name} (${num(stockOf(g))} шт)` })), '', 'id', 'name', 'Выберите товар')}</select>`)}${field('Кол-во', '<input class="input" name="qty" type="number" min="1" step="1">')}${field('Цена за шт.', '<input class="input" name="cost" type="number" min="0" step="0.01" placeholder="закупочная">')}<button type="button" class="x" data-del aria-label="Убрать строку">×</button></div>`;
  const m = formModal('Возврат поставщику', `${field('Поставщик', `<select class="input" name="sid">${opts(sups)}</select>`)}
    <div id="rows" style="display:grid;gap:10px">${row()}</div><button type="button" class="btn ghost sm" data-addrow style="justify-self:start">+ Ещё товар</button>
    ${field('Причина', inp('reason', { ph: 'Например, брак партии' }))}
    <p class="note" style="margin:0">Товар спишется со склада, а наш долг поставщику уменьшится на сумму возврата.</p>`,
  async (d, mm, f) => {
    const items = $$('.srow', f).map(r => ({ product_id: nOrNull($('[name=pid]', r).value), qty: nOrNull($('[name=qty]', r).value), price: nOrNull($('[name=cost]', r).value) })).filter(x => x.product_id && x.qty > 0);
    if (!items.length) throw new Error('Добавьте хотя бы один товар с количеством');
    const doc = await api('/api/stock/supplier_return', { method: 'POST', body: { store_id: S.storeId, supplier_id: +d.sid, reason: d.reason || null, items } });
    await api(`/api/stock/supplier_return/${doc.id}/complete`, { method: 'POST' });
    mm.close(); toast('Возврат поставщику проведён'); route();
  }, { wide: true, submit: 'Провести возврат' });
  m.el.addEventListener('click', e => {
    if (e.target.closest('[data-addrow]')) $('#rows', m.el).insertAdjacentHTML('beforeend', row());
    const del = e.target.closest('[data-del]'); if (del && $$('.srow', m.el).length > 1) del.closest('.srow').remove();
  });
}
async function supplierCard(s, sups) {
  const [orders, rets, pays] = await Promise.all([api('/api/stock/supplier_order' + qs({ supplier_id: s.id })), api('/api/stock/supplier_return' + qs({ supplier_id: s.id })), api(`/api/suppliers/${s.id}/payments`)]);
  const PS = o => o.paid >= o.total && o.total > 0 ? '<span class="tag green">оплачен</span>' : o.paid > 0 ? '<span class="tag">частично</span>' : '<span class="tag amber">не оплачен</span>';
  const m = modal(s.name, `<div class="kpis" style="margin-bottom:16px">
      <div class="kpi" style="background:var(--bg)"><span>Заказов на</span><b>${money(s.orders_total)}</b></div>
      <div class="kpi" style="background:var(--bg)"><span>Оплачено</span><b class="good">${money(s.paid_total)}</b></div>
      <div class="kpi" style="background:var(--bg)"><span>Наш долг</span><b class="${s.debt > 0 ? 'bad' : ''}">${money(Math.max(0, s.debt))}</b></div></div>
    <h2 style="font-size:16px">Заказы</h2>${orders.length ? `<div class="tbl-wrap"><table><thead><tr><th>№</th><th>Дата</th><th>Статус</th><th>Оплата</th><th class="r">Сумма</th><th class="r">Оплачено</th></tr></thead><tbody>${orders.map(o => `<tr><td>${o.id}</td><td>${fDateTime(o.created_at)}</td><td>${o.status === 'completed' ? '<span class="tag green">принят</span>' : o.status === 'draft' ? '<span class="tag grey">черновик</span>' : '<span class="tag grey">отменён</span>'}</td><td>${o.status === 'completed' ? PS(o) : ''}</td><td class="r">${money(o.total)}</td><td class="r">${num(o.paid)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Заказов нет.</p>'}
    ${rets.length ? `<h2 style="font-size:16px;margin-top:16px">Возвраты поставщику</h2><div class="tbl-wrap"><table><tbody>${rets.map(o => `<tr><td>№${o.id}</td><td>${fDateTime(o.created_at)}</td><td>${esc(o.reason || '')}</td><td class="r">${money(o.total)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <h2 style="font-size:16px;margin-top:16px">Оплаты</h2>${pays.length ? `<div class="tbl-wrap"><table><tbody>${pays.map(p => `<tr><td>${fDateTime(p.created_at)}</td><td>${{ cash: 'Наличные', card: 'Карта', transfer: 'Перечисление' }[p.method]}${p.document_id ? ` · заказ №${p.document_id}` : ''}${p.note ? `<br><small class="muted">${esc(p.note)}</small>` : ''}</td><td class="r good">${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Оплат не было.</p>'}
    <div class="modal-f"><button class="btn ghost" data-close>Закрыть</button><button class="btn" data-pay>Добавить оплату</button></div>`, { wide: true });
  $('[data-pay]', m.el).onclick = () => { m.close(); supplierPayModal(sups, s); };
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
const R = { period: 'month', tab: 'products', from: '', to: '' };
async function viewReports(v) {
  const r = rangeOf(R), q = { date_from: r.from, date_to: r.to };
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
  const days = Math.round((new Date(r.to) - new Date(r.from)) / 864e5) + 1;
  v.innerHTML = `<div class="head"><div><h1>Отчёты</h1><p class="sub">${fRange(r)} · ${days} ${plural(days, 'день', 'дня', 'дней')}. Выручка — с учётом скидок и возвратов, прибыль — минус себестоимость</p></div>${rangeControls(R, ['week', 'month', 'quarter', 'year'])}</div>
    <div class="chips">${Object.entries(tabs).filter(([k]) => k !== 'clients' || can('clients.read')).map(([k, t]) => `<button class="chip ${R.tab === k ? 'on' : ''}" data-tab="${k}">${t}</button>`).join('')}</div>
    <section class="panel">${R.tab === 'marketing' ? extra : ''}
      ${rows.length ? `<div class="tbl-wrap"><table><thead><tr>${head.map((h, i) => `<th class="${i ? 'r' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(rw => `<tr>${rw.map((c, i) => `<td class="${i ? 'r' : ''}">${i ? esc(c) : `<b>${esc(c)}</b>`}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <div class="modal-f"><button class="btn ghost sm" data-csv>Скачать CSV</button></div>` : '<p class="empty">За выбранный период данных нет.</p>'}
      ${R.tab === 'clients' ? extra : ''}</section>`;
  v.onchange = e => { if (rangeEvent(R, e)) route(); };
  v.onclick = e => {
    if (rangeEvent(R, e)) { route(); return; }
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
    <div class="two">${field('Малый остаток — когда штук не больше', inp('low_stock_threshold', { type: 'number', min: 0, step: 1, value: company.low_stock_threshold }))}${field('Срок долга по умолчанию, дней', inp('debt_days_default', { type: 'number', min: 0, step: 1, value: company.debt_days_default ?? 30 }))}</div>
    <label class="check"><input type="checkbox" name="allow_negative_stock" ${company.allow_negative_stock ? 'checked' : ''}> Разрешить продавать товар, которого нет на складе</label>
    <div class="err" hidden></div><button class="btn" type="submit" style="justify-self:start">Сохранить</button></form></section>
  <div class="grid" style="align-content:start">
  <section class="panel"><div class="head" style="margin-bottom:8px"><h2>Магазины</h2><button class="btn ghost sm" data-a="store">Добавить магазин</button></div>
    <div class="tbl-wrap"><table><tbody>${stores.map(s => `<tr class="click" data-s="${s.id}" tabindex="0"><td><b>${esc(s.name)}</b><br><small class="muted">${esc(s.address || 'адрес не указан')}</small></td><td class="r"><span class="tag ${s.is_active ? 'green' : 'grey'}">${s.is_active ? 'работает' : 'закрыт'}</span></td></tr>`).join('')}</tbody></table></div></section>
  <section class="panel"><div class="head" style="margin-bottom:8px"><h2>Перенос из BILLZ</h2><button class="btn ghost sm" data-a="billz">Перенести данные</button></div>
    <p class="muted" style="margin:0">Все данные: товары и остатки, сотрудники, клиенты, поставщики, история продаж и долги. Повторный перенос обновляет данные, а не дублирует их.</p></section>
  <section class="panel"><div class="head" style="margin-bottom:8px"><h2>Цели по выручке</h2><button class="btn ghost sm" data-a="target">Новая цель</button></div>
    ${targets.length ? `<div class="tbl-wrap"><table><tbody>${targets.map(t => `<tr><td>${fDay(t.period_start)} — ${fDay(t.period_end)}<br><small class="muted">${esc(t.store_id ? sn[t.store_id] : 'Все магазины')}</small></td><td class="r"><b>${money(t.amount)}</b></td><td class="r"><button class="btn link sm" data-deltarget="${t.id}">Удалить</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Целей пока нет.</p>'}</section>
  </div></div>`;
  $('#compF').onsubmit = async e => {
    e.preventDefault(); const f = e.target, d = Object.fromEntries(new FormData(f)), err = $('.err', f);
    try {
      S.company = await api('/api/company', { method: 'PATCH', body: { name: d.name, currency: d.currency.trim(), utc_offset_minutes: Math.round((nOrNull(d.tz) || 0) * 60),
        loyalty_percent: nOrNull(d.loyalty_percent) || 0, max_bonus_payment_percent: nOrNull(d.max_bonus_payment_percent) || 0, low_stock_threshold: nOrNull(d.low_stock_threshold) || 0, allow_negative_stock: !!d.allow_negative_stock, debt_days_default: nOrNull(d.debt_days_default) ?? 30 } });
      err.hidden = true; toast('Настройки сохранены'); renderShell(); route();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  };
  const storeModal = s => formModal(s ? s.name : 'Новый магазин', `${field('Название', inp('name', { value: s?.name || '', req: true }))}${field('Адрес', inp('address', { value: s?.address || '' }))}
    <label class="check"><input type="checkbox" name="is_active" ${s?.is_active ?? true ? 'checked' : ''}> Работает</label>`,
  async (d, m) => {
    await api(s ? `/api/stores/${s.id}` : '/api/stores', { method: s ? 'PUT' : 'POST', body: { name: d.name, address: d.address || null, is_active: !!d.is_active } });
    S.stores = (await api('/api/stores')).filter(x => x.is_active); m.close(); toast('Магазин сохранён'); renderShell(); route();
  });
  const billzModal = () => formModal('Перенос из BILLZ', `<p class="muted" style="margin:0">Переносится всё: магазины, категории, товары с ценами и остатками, сотрудники, клиенты с кэшбэком, поставщики с долгами, вся история продаж и возвратов, долги клиентов.</p>
    ${field('Ключ API из BILLZ', '<input class="input" name="secret_token" type="password" autocomplete="off" required minlength="20">')}
    <p class="muted" style="margin:0">Ключ создаётся в BILLZ: Настройки → Интеграции. Дайте ему доступ на чтение ко всем разделам. Ключ не сохраняется. Не закрывайте вкладку, пока идёт перенос: история продаж переносится по месяцам.</p>
    <div id="bzLog" class="blist" hidden></div>`,
  async (d, m) => {
    const btn = $('button[type=submit]', m.el), log = $('#bzLog', m.el), key = d.secret_token.trim();
    const tot = {}; log.hidden = false; log.innerHTML = '';
    const line = t => { const p = document.createElement('p'); p.textContent = t; log.append(p); return p; };
    const add = r => { for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && !['month_transactions', 'billz_products', 'next_page'].includes(k)) tot[k] = (tot[k] || 0) + v; (r.notes || []).forEach(n => (tot.notes ||= new Set()).add(n)); (r.stock_stores || []).forEach(n => (tot.stockStores ||= new Set()).add(n)); };
    const call = (step, month, page) => api('/api/import/billz', { method: 'POST', body: { secret_token: key, step, month, page } });
    btn.textContent = 'Переношу…';
    try {
      const pc = line('Товары…'); let page = 1, r;
      do {
        r = await call('catalog', null, page); add(r);
        pc.textContent = `Товары: ${Math.min(page * 100, r.billz_products || page * 100)} из ${r.billz_products || '…'}`;
        page = r.next_page;
      } while (page);
      pc.textContent = `Товары — готово (${r.billz_products || 0} в BILLZ)`;
      for (const [step, label] of [['staff', 'Сотрудники'], ['people', 'Клиенты и поставщики']]) {
        const p = line(label + '…'); add(await call(step)); p.textContent = label + ' — готово';
      }
      const ps = line('Ищу, с какого месяца начинается история продаж…'); let empty = 0, sales = 0, months = [];
      const dt = new Date(); dt.setDate(1);
      const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      for (let i = 0; i < 180 && empty < 12; i++) {
        const mon = ym(dt), r = await call('count', mon);
        if (r.month_transactions) { months.unshift(mon); empty = 0; } else empty++;
        ps.textContent = `Ищу начало истории: ${mon}, месяцев с продажами — ${months.length}`;
        dt.setMonth(dt.getMonth() - 1);
      }
      if (!months.length) (tot.notes ||= new Set()).add('BILLZ не отдал ни одного чека. Проверьте, что у ключа есть доступ на чтение продаж, и запустите перенос ещё раз.');
      for (const [i, mon] of months.entries()) {
        let r;
        do {
          ps.textContent = `Продажи: ${mon} (${i + 1} из ${months.length}), перенесено чеков ${sales}`;
          r = await call('sales', mon); add(r); sales += r.sales_created + r.returns_created;
        } while (r.incomplete);
        if (r.warnings) r.warnings.forEach(w => (tot.notes ||= new Set()).add('BILLZ: ' + w));
      }
      ps.textContent = `Продажи — готово, перенесено чеков: ${sales}`;
      const pd = line('Долги клиентов…'); add(await call('debts')); pd.textContent = 'Долги клиентов — готово';
      m.close();
      modal('Данные перенесены', `<div class="blist">
        <p>Товаров: новых <b>${tot.products_created || 0}</b>, обновлено <b>${tot.products_updated || 0}</b>; строк остатков: <b>${tot.stock_lines || 0}</b></p>
        <p>Продаж: <b>${tot.sales_created || 0}</b>, возвратов: <b>${tot.returns_created || 0}</b>${tot.sales_skipped ? `, уже были: ${tot.sales_skipped}` : ''}</p>
        <p>Клиентов: новых <b>${tot.clients_created || 0}</b>, обновлено <b>${tot.clients_updated || 0}</b>; долгов: <b>${(tot.debts_created || 0) + (tot.debts_updated || 0)}</b></p>
        <p>Поставщиков: <b>${(tot.suppliers_created || 0) + (tot.suppliers_updated || 0)}</b>, сотрудников: <b>${tot.staff_created || 0}</b></p>
        <p>Магазинов создано: <b>${tot.stores_created || 0}</b>, категорий: <b>${tot.categories_created || 0}</b></p>
        ${tot.stockStores ? `<p>Остатки записаны в магазины: <b>${[...tot.stockStores].map(esc).join(', ')}</b>. Остаток в списке товаров показывается по магазину, выбранному слева вверху.</p>` : ''}
        ${tot.notes ? `<p class="muted">${[...tot.notes].map(esc).join('<br>')}</p>` : ''}</div>`);
      S.stores = (await api('/api/stores')).filter(x => x.is_active); renderShell(); route();
    } catch (x) { line('Остановлено: ' + x.message + '. Запустите перенос ещё раз — уже перенесённое не задвоится.'); throw x; }
    finally { btn.textContent = 'Перенести'; }
  }, { submit: 'Перенести' });
  v.onclick = async e => {
    const t = e.target.closest('[data-a],[data-s],[data-deltarget]'); if (!t) return;
    if (t.dataset.a === 'store') storeModal(null);
    if (t.dataset.s) storeModal(stores.find(s => s.id === +t.dataset.s));
    if (t.dataset.a === 'target') targetModal();
    if (t.dataset.a === 'billz') billzModal();
    if (t.dataset.deltarget) { await api(`/api/targets/${t.dataset.deltarget}`, { method: 'DELETE' }); toast('Цель удалена'); route(); }
  };
}

boot();
})();
