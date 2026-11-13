import {
  DEMO, getEvents, getSettings, getAdminSession, signIn, signOut,
  listOrders, setOrderStatus, saveEvent, saveSettings, uploadImage, resetDemo,
} from './data.js';
import { money, longDate, dateTime, esc, isPast, toLocalInput, fromLocalInput, slugify, toast } from './util.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;

const st = {
  events: [],
  orders: [],
  eventId: null,
  filter: 'pendiente',
  q: '',
  open: new Set(),
};

// ───────────────────────── AUTH ─────────────────────────

async function boot() {
  const session = await getAdminSession().catch(() => null);
  if (session && !session.notAdmin) return startApp(session);
  showLogin();
}

function showLogin() {
  $('[data-app]').hidden = true;
  $('[data-login]').hidden = false;
  if (DEMO) $('[data-login-hint]').textContent = 'Modo demo: entra con cualquier correo y contraseña.';
  $('[data-login-form] input').focus();
}

$('[data-login-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const err = $('[data-login-error]');
  const btn = $('button[type=submit]', f);
  err.hidden = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    const s = await signIn(f.email.value.trim(), f.password.value);
    startApp(s);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

$('[data-logout]').addEventListener('click', async () => {
  await signOut();
  location.reload();
});

async function startApp(session) {
  $('[data-login]').hidden = true;
  $('[data-app]').hidden = false;
  $('[data-user]').textContent = session.email || '';
  if (DEMO) {
    const n = document.createElement('div');
    n.className = 'demo-note';
    n.innerHTML = `<span>Modo demo: los datos viven solo en este navegador. Conecta Supabase en <code>js/config.js</code> para producción.</span><button data-reset-demo>Reiniciar datos demo</button>`;
    $('.main').prepend(n);
    $('[data-reset-demo]', n).addEventListener('click', () => { resetDemo(); location.reload(); });
  }
  await Promise.all([loadEvents(), loadOrders()]);
  const upcoming = st.events.find((e) => !isPast(e));
  st.eventId = (upcoming || st.events.at(-1))?.id ?? null;
  renderEventSelect();
  renderOrders();
  renderEventsList();
  loadSettingsForm();
}

// ───────────────────────── TABS ─────────────────────────

$$('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  $$('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  if (b.dataset.tab === 'events') closeEditor();
  window.scrollTo({ top: 0 });
}));

// ───────────────────────── ÓRDENES ─────────────────────────

async function loadEvents() { st.events = await getEvents({ includeHidden: true }); }
async function loadOrders() { st.orders = await listOrders(); }

function renderEventSelect() {
  const sel = $('[data-ev-select]');
  sel.innerHTML = st.events
    .slice()
    .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at))
    .map((e) => `<option value="${e.id}" ${e.id === st.eventId ? 'selected' : ''}>${esc(e.title)} · ${esc(longDate(e.starts_at))}</option>`)
    .join('');
}
$('[data-ev-select]').addEventListener('change', (e) => { st.eventId = e.target.value; st.open.clear(); renderOrders(); });
$('[data-reload]').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  await loadOrders().catch((ex) => toast(ex.message, 'error'));
  b.disabled = false;
  renderOrders();
  toast('Actualizado');
});

$$('[data-f]').forEach((b) => b.addEventListener('click', () => {
  st.filter = b.dataset.f;
  $$('[data-f]').forEach((x) => x.setAttribute('aria-selected', x === b));
  renderTable();
}));
$('[data-search]').addEventListener('input', (e) => { st.q = e.target.value.trim().toLowerCase(); renderTable(); });

const evOrders = () => st.orders.filter((o) => o.event_id === st.eventId);

function renderOrders() {
  const os = evOrders();
  const live = os.filter((o) => o.status !== 'cancelado');
  const paid = os.filter((o) => o.status === 'pagado');
  const pend = os.filter((o) => o.status === 'pendiente');
  const sum = (arr, k) => arr.reduce((n, o) => n + o[k], 0);
  $('[data-kpis]').innerHTML = `
    <div class="kpi"><small>Entradas reservadas</small><b>${sum(live, 'quantity')}</b><span>${live.length} órdenes</span></div>
    <div class="kpi"><small>Entradas pagadas</small><b>${sum(paid, 'quantity')}</b><span>${paid.length} órdenes</span></div>
    <div class="kpi"><small>Recaudado</small><b>${money(sum(paid, 'total'))}</b><span>confirmado</span></div>
    <div class="kpi kpi--accent"><small>Por cobrar</small><b>${money(sum(pend, 'total'))}</b><span>${pend.length} pendientes</span></div>`;

  const ev = st.events.find((e) => e.id === st.eventId);
  $('[data-tierbar]').innerHTML = (ev?.tiers || []).map((t) => {
    const n = live.filter((o) => o.tier_id === t.id).reduce((a, o) => a + o.quantity, 0);
    return `<span>${esc(t.name)} · <b>${n}${t.capacity ? ` / ${t.capacity}` : ''}</b></span>`;
  }).join('');

  const counts = { pendiente: pend.length, pagado: paid.length, cancelado: os.length - live.length, all: os.length };
  $$('[data-c]').forEach((i) => (i.textContent = counts[i.dataset.c]));
  renderTable();
}

function filtered() {
  return evOrders().filter((o) => {
    if (st.filter !== 'all' && o.status !== st.filter) return false;
    if (!st.q) return true;
    const hay = [o.code, o.buyer_name, o.buyer_email, ...(o.tickets || []).flatMap((t) => [t.first_name, t.last_name, t.email])].join(' ').toLowerCase();
    return hay.includes(st.q);
  });
}

const STATUS_LABEL = { pendiente: 'Pendiente', pagado: 'Pagado', cancelado: 'Cancelado' };

function actionsHTML(o) {
  if (o.status === 'pendiente') return `
    <button class="btn btn--ok btn--sm" data-act="pagado">${icon('check')}Marcar pagado</button>
    <button class="iconbtn" data-act="cancelado" aria-label="Cancelar orden" title="Cancelar orden">${icon('x')}</button>`;
  if (o.status === 'pagado') return `<button class="btn btn--quiet btn--sm" data-act="pendiente">${icon('undo')}Volver a pendiente</button>`;
  return `<button class="btn btn--quiet btn--sm" data-act="pendiente">${icon('undo')}Reactivar</button>`;
}

function rowHTML(o) {
  const open = st.open.has(o.id);
  return `
    <div class="tr row" role="row" data-id="${o.id}" aria-expanded="${open}" tabindex="0">
      <span class="code" role="cell">${icon('chev')}${esc(o.code)}</span>
      <span class="who" role="cell"><b>${esc(o.buyer_name)}</b><small>${esc(o.buyer_email)}</small></span>
      <span class="muted" role="cell">${o.quantity} × ${esc(o.tier_name)}</span>
      <span class="num r" role="cell">${o.quantity}</span>
      <span class="num r" role="cell"><b>${money(o.total)}</b></span>
      <span class="muted num" role="cell">${esc(dateTime(o.created_at))}</span>
      <span role="cell"><span class="pill pill--${o.status}">${STATUS_LABEL[o.status]}</span></span>
      <span class="acts" role="cell">${actionsHTML(o)}</span>
      <div class="detail" data-open="${open}">
        <div>
          <ul class="att-list">
            ${(o.tickets || []).map((t) => `<li><span>${esc(t.first_name)} ${esc(t.last_name)}</span><span>${esc(t.email)}</span></li>`).join('')}
          </ul>
          <p class="att-meta">
            <span>Precio unitario: ${money(o.unit_price)}</span>
            ${o.paid_at ? `<span>Pagado: ${esc(dateTime(o.paid_at))}</span>` : ''}
          </p>
        </div>
      </div>
    </div>`;
}

function renderTable() {
  const rows = filtered();
  const empty = {
    pendiente: 'No hay órdenes pendientes. Todo al día.',
    pagado: 'Aún no hay órdenes pagadas.',
    cancelado: 'No hay órdenes canceladas.',
    all: 'Todavía no hay órdenes para este evento.',
  }[st.filter];
  $('[data-orders]').innerHTML = `
    <div class="tr th" role="row">
      <span role="columnheader">Código</span><span role="columnheader">Comprador</span><span role="columnheader">Tramo</span>
      <span role="columnheader" class="r">Cant.</span><span role="columnheader" class="r">Total</span>
      <span role="columnheader">Fecha</span><span role="columnheader">Estado</span><span role="columnheader" class="r">Acción</span>
    </div>
    ${rows.length ? rows.map(rowHTML).join('') : `<div class="empty-row">${st.q ? 'Sin resultados para esa búsqueda.' : empty}</div>`}`;
}

$('[data-orders]').addEventListener('click', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const act = e.target.closest('[data-act]');
  if (!act) return toggleRow(row);

  const o = st.orders.find((x) => x.id === row.dataset.id);
  const next = act.dataset.act;
  if (next === 'cancelado' && !confirm(`¿Cancelar la orden ${o.code}? Las entradas vuelven a quedar disponibles.`)) return;
  const prev = o.status;
  act.disabled = true;
  // optimista
  o.status = next;
  o.paid_at = next === 'pagado' ? new Date().toISOString() : null;
  renderOrders();
  try {
    const saved = await setOrderStatus(o.id, next);
    Object.assign(o, saved);
    toast(next === 'pagado' ? `${o.code} marcada como pagada` : next === 'cancelado' ? `${o.code} cancelada` : `${o.code} volvió a pendiente`);
  } catch (ex) {
    o.status = prev;
    renderOrders();
    toast(ex.message, 'error');
  }
});
$('[data-orders]').addEventListener('keydown', (e) => {
  const row = e.target.closest('.row');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(row); }
});
function toggleRow(row) {
  const id = row.dataset.id;
  const open = !st.open.has(id);
  open ? st.open.add(id) : st.open.delete(id);
  row.setAttribute('aria-expanded', open);
  $('.detail', row).dataset.open = open;
}

// ───────────────────────── EVENTOS ─────────────────────────

function renderEventsList() {
  const list = $('[data-events-list]');
  const sorted = st.events.slice().sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  list.innerHTML = `
    <div class="head">
      <div><p class="eyebrow">Agenda</p><h1 class="h1">Eventos y precios</h1></div>
      <button class="btn btn--primary" data-new-event>${icon('plus')}Nuevo evento</button>
    </div>
    <div class="ev-list">
      ${sorted.map((e) => {
        const past = isPast(e);
        const img = e.cover_url || e.poster_url;
        return `
          <button class="card ev" data-edit="${e.id}">
            ${img ? `<img class="ev__thumb" src="${esc(img)}" alt="" />` : `<span class="ev__thumb">${icon('crown')}</span>`}
            <span>
              <span class="ev__t">${esc(e.title)}</span>
              <span class="ev__m" style="display:block">${esc(longDate(e.starts_at))} · ${esc(e.venue || e.location)}</span>
              <span class="ev__tiers">${e.tiers.map((t) => `<span class="${t.is_active ? '' : 'off'}">${esc(t.name)} ${money(t.price)}</span>`).join('') || '<span>Sin tramos</span>'}</span>
            </span>
            <span class="ev__r">
              ${!e.is_published ? '<span class="chip">Oculto</span>' : past ? '<span class="chip">Archivo</span>' : '<span class="chip chip--live">En venta</span>'}
              ${icon('chev')}
            </span>
          </button>`;
      }).join('')}
    </div>`;
  $('[data-new-event]', list).addEventListener('click', () => openEditor(null));
  $$('[data-edit]', list).forEach((b) => b.addEventListener('click', () => openEditor(b.dataset.edit)));
}

let draft = null;

function openEditor(id) {
  const ev = id ? st.events.find((e) => e.id === id) : null;
  draft = {
    ev: ev ? { ...ev } : {
      title: '', subtitle: '', format_label: 'Formato discoteca', starts_at: null, location: 'Tomé, Biobío',
      venue: 'Recinto y horario por anunciar', cover_url: null, is_published: true,
    },
    tiers: ev ? ev.tiers.map((t) => ({ ...t })) : [
      { name: 'Preventa 1', price: 4000, capacity: null, is_active: true },
      { name: 'Preventa 2', price: 5000, capacity: null, is_active: true },
      { name: 'General', price: 7000, capacity: null, is_active: true },
    ],
    removed: [],
  };
  $('[data-events-list]').hidden = true;
  const ed = $('[data-event-editor]');
  ed.hidden = false;
  renderEditor();
  window.scrollTo({ top: 0 });
}
function closeEditor() {
  draft = null;
  $('[data-event-editor]').hidden = true;
  $('[data-events-list]').hidden = false;
}

function imgField(name, label, url) {
  return `
    <div class="field full">
      <span>${label}</span>
      <div class="img-field">
        ${url ? `<img class="img-prev" src="${esc(url)}" alt="" data-prev="${name}" />` : `<span class="img-prev" data-prev="${name}">${icon('img')}</span>`}
        <div class="img-field__in">
          <input class="input" name="${name}" placeholder="https://… o sube una imagen" value="${esc(url && !url.startsWith('data:') ? url : '')}" />
          <div class="img-field__btns">
            <label class="btn btn--quiet btn--sm upload">Subir imagen<input type="file" accept="image/*" data-upload="${name}" /></label>
            ${url ? `<button type="button" class="btn btn--quiet btn--sm" data-clear-img="${name}">Quitar</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

function renderEditor() {
  const { ev, tiers } = draft;
  const ed = $('[data-event-editor]');
  ed.innerHTML = `
    <button class="back" data-back>${icon('left')}Volver a eventos</button>
    <div class="head"><div><p class="eyebrow">${ev.id ? 'Editar' : 'Crear'}</p><h1 class="h1">${ev.id ? esc(ev.title) : 'Nuevo evento'}</h1></div></div>
    <form class="card form" data-ev-form novalidate>
      <section class="block">
        <div class="block__h"><h2>Información</h2>
          <label class="switch"><input type="checkbox" name="is_published" ${ev.is_published ? 'checked' : ''} /><i></i>Publicado</label>
        </div>
        <div class="grid2">
          <label class="field full"><span>Nombre del evento</span><input class="input" name="title" value="${esc(ev.title)}" required placeholder="Chao Clases 2026" /></label>
          <label class="field full"><span>Descripción corta</span><input class="input" name="subtitle" value="${esc(ev.subtitle || '')}" placeholder="Una noche con DJs para…" /></label>
          <label class="field"><span>Fecha y hora</span><input class="input" type="datetime-local" name="starts_at" value="${esc(toLocalInput(ev.starts_at))}" required /></label>
          <label class="field"><span>Etiqueta</span><input class="input" name="format_label" value="${esc(ev.format_label || '')}" /></label>
          <label class="field"><span>Ciudad</span><input class="input" name="location" value="${esc(ev.location || '')}" /></label>
          <label class="field"><span>Recinto / horario</span><input class="input" name="venue" value="${esc(ev.venue || '')}" /></label>
          ${imgField('cover_url', 'Foto o afiche (si no hay, se genera un afiche tipográfico)', ev.cover_url)}
        </div>
      </section>

      <section class="block">
        <div class="block__h"><div><h2>Entradas y precios</h2><p>Desactiva un tramo para marcarlo como agotado.</p></div>
          <button type="button" class="btn btn--quiet btn--sm" data-add-tier>${icon('plus')}Agregar tramo</button>
        </div>
        <div class="tier-rows">
          ${tiers.map((t, i) => `
            <div class="tier-row" data-ti="${i}">
              <label class="field"><span>Nombre</span><input class="input" data-tf="name" value="${esc(t.name)}" /></label>
              <label class="field"><span>Precio (CLP)</span><span class="money-in"><input class="input" data-tf="price" inputmode="numeric" value="${t.price ?? ''}" /></span></label>
              <label class="field"><span>Cupo</span><input class="input" data-tf="capacity" inputmode="numeric" placeholder="∞" value="${t.capacity ?? ''}" /></label>
              <label class="switch" title="Tramo activo"><input type="checkbox" data-tf="is_active" ${t.is_active ? 'checked' : ''} /><i></i></label>
              <button type="button" class="iconbtn" data-del-tier="${i}" aria-label="Eliminar tramo">${icon('trash')}</button>
            </div>`).join('')}
        </div>
      </section>

      <details class="block" ${ev.attendance || ev.poster_url || ev.recap_url ? 'open' : ''}>
        <summary><span><b style="font-size:15px">Archivo (después del evento)</b><br><small class="hint">Aparece en "Archivo" cuando la fecha ya pasó.</small></span>${icon('chev')}</summary>
        <div class="grid2">
          <label class="field"><span>Asistentes</span><input class="input" name="attendance" inputmode="numeric" value="${ev.attendance ?? ''}" placeholder="500" /></label>
          <label class="field full"><span>Texto corto</span><input class="input" name="recap_text" value="${esc(ev.recap_text || '')}" placeholder="Gracias a todos los que…" /></label>
          ${imgField('poster_url', 'Afiche', ev.poster_url)}
          ${imgField('recap_url', 'Imagen de cierre', ev.recap_url)}
        </div>
      </details>

      <p class="form-error" data-ev-error hidden role="alert"></p>
      <div class="form__foot">
        <button type="button" class="btn btn--quiet" data-back>Cancelar</button>
        <button type="submit" class="btn btn--primary">${ev.id ? 'Guardar cambios' : 'Crear evento'}</button>
      </div>
    </form>`;
  bindEditor(ed);
}

function readForm(form) {
  const { ev, tiers } = draft;
  const fd = new FormData(form);
  for (const k of ['title', 'subtitle', 'format_label', 'location', 'venue', 'recap_text']) ev[k] = (fd.get(k) || '').toString().trim() || null;
  for (const k of ['cover_url', 'poster_url', 'recap_url']) {
    const v = (fd.get(k) || '').toString().trim();
    if (v) ev[k] = v;
    else if (!String(ev[k] || '').startsWith('data:')) ev[k] = null;
  }
  const sa = fd.get('starts_at');
  ev.starts_at = sa ? fromLocalInput(sa) : null;
  const att = parseInt(String(fd.get('attendance') || '').replace(/\D/g, ''), 10);
  ev.attendance = Number.isFinite(att) ? att : null;
  ev.is_published = form.is_published.checked;
  $$('[data-ti]', form).forEach((row) => {
    const t = tiers[+row.dataset.ti];
    t.name = $('[data-tf=name]', row).value.trim();
    t.price = parseInt($('[data-tf=price]', row).value.replace(/\D/g, ''), 10);
    const cap = parseInt($('[data-tf=capacity]', row).value.replace(/\D/g, ''), 10);
    t.capacity = Number.isFinite(cap) && cap > 0 ? cap : null;
    t.is_active = $('[data-tf=is_active]', row).checked;
  });
}

function bindEditor(ed) {
  const form = $('[data-ev-form]', ed);
  $$('[data-back]', ed).forEach((b) => b.addEventListener('click', closeEditor));
  $('[data-add-tier]', ed).addEventListener('click', () => {
    readForm(form);
    draft.tiers.push({ name: '', price: '', capacity: null, is_active: true });
    renderEditor();
    $$('[data-tf=name]').at(-1).focus();
  });
  $$('[data-del-tier]', ed).forEach((b) => b.addEventListener('click', () => {
    readForm(form);
    const [t] = draft.tiers.splice(+b.dataset.delTier, 1);
    if (t.id) draft.removed.push(t.id);
    renderEditor();
  }));
  $$('[data-upload]', ed).forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('La imagen pesa más de 5 MB', 'error');
    readForm(form);
    const label = inp.parentElement;
    label.firstChild.textContent = 'Subiendo…';
    try {
      draft.ev[inp.dataset.upload] = await uploadImage(file);
      renderEditor();
      toast('Imagen cargada');
    } catch (ex) {
      label.firstChild.textContent = 'Subir imagen';
      toast(ex.message, 'error');
    }
  }));
  $$('[data-clear-img]', ed).forEach((b) => b.addEventListener('click', () => {
    readForm(form);
    draft.ev[b.dataset.clearImg] = null;
    renderEditor();
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readForm(form);
    const err = $('[data-ev-error]', ed);
    const { ev, tiers, removed } = draft;
    const problem =
      !ev.title ? 'Falta el nombre del evento.' :
      !ev.starts_at ? 'Falta la fecha y hora.' :
      tiers.some((t) => !t.name) ? 'Cada tramo necesita un nombre.' :
      tiers.some((t) => !Number.isFinite(t.price) || t.price < 0) ? 'Revisa los precios: solo números, sin puntos.' : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    err.hidden = true;
    if (!ev.id) ev.slug = `${slugify(ev.title)}-${Date.now().toString(36).slice(-4)}`;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Guardando…';
    try {
      const id = await saveEvent(ev, tiers, removed);
      await loadEvents();
      st.eventId ||= id;
      renderEventSelect();
      renderOrders();
      renderEventsList();
      closeEditor();
      toast(ev.id ? 'Cambios guardados' : 'Evento creado');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = ev.id ? 'Guardar cambios' : 'Crear evento';
    }
  });
}

// ───────────────────────── CONTACTO ─────────────────────────

async function loadSettingsForm() {
  const s = await getSettings();
  const f = $('[data-settings-form]');
  for (const [k, v] of Object.entries(s || {})) if (f.elements[k]) f.elements[k].value = v ?? '';
}
$('[data-settings-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const data = Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v).trim() || null]));
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    await saveSettings(data);
    toast('Contacto guardado');
  } catch (ex) {
    toast(ex.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

boot();
