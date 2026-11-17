import {
  DEMO, getEvents, getSettings, getAdminSession, signIn, signOut,
  listOrders, setOrderStatus, saveEvent, saveSettings, uploadImage, resetDemo,
  transferTicket, undoCheckIn,
} from './data.js';
import { loadQR, qrSVG, downloadTicketsPDF } from './ticket.js';
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
  transfer: null, // id de la entrada que se está traspasando
  qr: false,      // generador de QR cargado
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
  await Promise.all([loadEvents(), loadOrders(), loadQR().then(() => (st.qr = true)).catch(() => {})]);
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
$('[data-ev-select]').addEventListener('change', (e) => { st.eventId = e.target.value; st.open.clear(); st.transfer = null; renderOrders(); });
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
    if (t.door_only) return `<span>${esc(t.name)} · <b>solo en puerta</b></span>`;
    return `<span>${esc(t.name)} · <b>${n}${t.capacity ? ` / ${t.capacity}` : ''}</b></span>`;
  }).join('') + `<span>Ingresaron · <b>${paid.flatMap((o) => o.tickets || []).filter((t) => t.checked_in_at).length} / ${sum(paid, 'quantity')}</b></span>`;

  const counts = { pendiente: pend.length, pagado: paid.length, cancelado: os.length - live.length, all: os.length };
  $$('[data-c]').forEach((i) => (i.textContent = counts[i.dataset.c]));
  renderTable();
}

function filtered() {
  return evOrders().filter((o) => {
    if (st.filter !== 'all' && o.status !== st.filter) return false;
    if (!st.q) return true;
    const hay = [o.code, o.buyer_name, ...(o.tickets || []).flatMap((t) => [t.first_name, t.last_name])].join(' ').toLowerCase();
    return hay.includes(st.q);
  });
}

const STATUS_LABEL = { pendiente: 'Pendiente', pagado: 'Pagado', cancelado: 'Cancelado' };

function actionsHTML(o) {
  if (o.status === 'pendiente') return `
    <button class="btn btn--ok btn--sm" data-act="pagado">${icon('check')}Marcar pagado</button>
    <button class="iconbtn" data-act="cancelado" aria-label="Cancelar orden" title="Cancelar orden">${icon('x')}</button>`;
  if (o.status === 'pagado') return `
    <button class="btn btn--quiet btn--sm" data-pdf>${icon('dl')}Entrada PDF</button>
    <button class="iconbtn" data-act="pendiente" aria-label="Volver a pendiente" title="Volver a pendiente">${icon('undo')}</button>`;
  return `<button class="btn btn--quiet btn--sm" data-act="pendiente">${icon('undo')}Reactivar</button>`;
}

function ticketHTML(o, t, open) {
  const paid = o.status === 'pagado';
  if (st.transfer === t.id) return `
    <li class="tk tk--edit" data-ticket="${t.id}">
      <form class="tk__form" data-transfer-form novalidate>
        <p class="tk__formh">Traspasar la entrada de <b>${esc(t.first_name)} ${esc(t.last_name)}</b></p>
        <label class="field"><span>Nombre de quien la recibe</span><input class="input" name="first_name" maxlength="60" autocomplete="off" required /></label>
        <label class="field"><span>Apellido</span><input class="input" name="last_name" maxlength="60" autocomplete="off" required /></label>
        <div class="tk__formb">
          <button class="btn btn--primary btn--sm" type="submit">Traspasar</button>
          <button class="btn btn--quiet btn--sm" type="button" data-transfer-cancel>Cancelar</button>
        </div>
        <p class="hint">Se genera un QR nuevo y el anterior deja de servir. Después descarga el PDF otra vez y mándaselo a la persona nueva.</p>
      </form>
    </li>`;
  const status = t.checked_in_at ? `Ingresó · ${esc(dateTime(t.checked_in_at))}` : paid ? 'Aún no ingresa' : 'QR inactivo hasta marcar la orden como pagada';
  return `
    <li class="tk" data-ticket="${t.id}">
      ${paid && st.qr
        ? `<span class="tk__qr" data-qr="${esc(t.qr_code)}">${open ? qrSVG(t.qr_code) : ''}</span>`
        : `<span class="tk__qr tk__qr--off">${paid ? 'QR' : 'QR al pagar'}</span>`}
      <span class="tk__info">
        <b>${esc(t.first_name)} ${esc(t.last_name)}</b>
        <code>${esc(t.qr_code || '')}</code>
        <small class="${t.checked_in_at ? 'tk__in' : ''}">${status}</small>
      </span>
      <span class="tk__acts">
        ${t.checked_in_at
          ? `<button class="btn btn--quiet btn--sm" data-undo-in>${icon('undo')}Deshacer ingreso</button>`
          : o.status !== 'cancelado' ? `<button class="btn btn--quiet btn--sm" data-transfer>Traspasar</button>` : ''}
      </span>
    </li>`;
}

function rowHTML(o) {
  const open = st.open.has(o.id);
  return `
    <div class="tr row" role="row" data-id="${o.id}" aria-expanded="${open}" tabindex="0">
      <span class="code" role="cell">${icon('chev')}${esc(o.code)}</span>
      <span class="who" role="cell"><b>${esc(o.buyer_name)}</b>${o.quantity > 1 ? `<small>+ ${o.quantity - 1} ${o.quantity === 2 ? 'persona' : 'personas'}</small>` : ''}</span>
      <span class="muted" role="cell">${o.quantity} × ${esc(o.tier_name)}</span>
      <span class="num r" role="cell">${o.quantity}</span>
      <span class="num r" role="cell"><b>${money(o.total)}</b></span>
      <span class="muted num" role="cell">${esc(dateTime(o.created_at))}</span>
      <span role="cell"><span class="pill pill--${o.status}">${STATUS_LABEL[o.status]}</span></span>
      <span class="acts" role="cell">${actionsHTML(o)}</span>
      <div class="detail" data-open="${open}">
        <div>
          <ul class="tk-list">
            ${(o.tickets || []).map((t) => ticketHTML(o, t, open)).join('')}
          </ul>
          <p class="att-meta">
            <span>Precio unitario: ${money(o.unit_price)}</span>
            ${o.paid_at ? `<span>Pagado: ${esc(dateTime(o.paid_at))}</span>` : ''}
            ${o.terms_accepted_at ? `<span>Aceptó términos y privacidad: ${esc(dateTime(o.terms_accepted_at))}</span>` : ''}
            ${o.status === 'pendiente' && o.expires_at ? `<span>Vence si no paga: ${esc(dateTime(o.expires_at))}</span>` : ''}
            ${o.status === 'cancelado' && o.notes ? `<span>${esc(o.notes)}</span>` : ''}
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
  const o = st.orders.find((x) => x.id === row.dataset.id);
  const btn = e.target.closest('button');
  const li = e.target.closest('[data-ticket]');

  if (btn?.matches('[data-pdf]')) {
    btn.disabled = true;
    try {
      await downloadTicketsPDF(o, st.events.find((x) => x.id === o.event_id));
      toast('PDF descargado');
    } catch (ex) {
      toast(ex.message || 'No se pudo crear el PDF', 'error');
    }
    btn.disabled = false;
    return;
  }
  if (btn?.matches('[data-transfer]')) {
    st.transfer = li.dataset.ticket;
    st.open.add(o.id);
    renderTable();
    $('[data-transfer-form] input')?.focus();
    return;
  }
  if (btn?.matches('[data-transfer-cancel]')) { st.transfer = null; renderTable(); return; }
  if (btn?.matches('[data-undo-in]')) {
    const t = o.tickets.find((x) => x.id === li.dataset.ticket);
    if (!confirm(`¿Deshacer el ingreso de ${t.first_name} ${t.last_name}? Su QR volverá a servir para entrar.`)) return;
    btn.disabled = true;
    try {
      await undoCheckIn(t.id);
      t.checked_in_at = null;
      renderOrders();
      toast('Ingreso deshecho');
    } catch (ex) {
      btn.disabled = false;
      toast(ex.message, 'error');
    }
    return;
  }

  const act = e.target.closest('[data-act]');
  if (!act) {
    // dentro del detalle (QR, nombres, formulario) no se pliega la fila
    if (!e.target.closest('.detail')) toggleRow(row);
    return;
  }
  const next = act.dataset.act;
  if (next === 'pendiente' && o.status === 'cancelado') { o.expires_at = new Date(Date.now() + 24 * 3600e3).toISOString(); o.notes = null; }
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
// traspaso de una entrada
$('[data-orders]').addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-transfer-form]');
  if (!form) return;
  e.preventDefault();
  const row = form.closest('.row');
  const o = st.orders.find((x) => x.id === row.dataset.id);
  const t = o.tickets.find((x) => x.id === form.closest('[data-ticket]').dataset.ticket);
  const first = form.first_name.value.trim();
  const last = form.last_name.value.trim();
  form.first_name.setAttribute('aria-invalid', String(!first));
  form.last_name.setAttribute('aria-invalid', String(!last));
  if (!first || !last) return (first ? form.last_name : form.first_name).focus();
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    Object.assign(t, await transferTicket(t.id, first, last));
    if (o.quantity === 1) o.buyer_name = `${t.first_name} ${t.last_name}`;
    st.transfer = null;
    renderTable();
    toast('Entrada traspasada. Descarga el PDF nuevo.');
  } catch (ex) {
    btn.disabled = false;
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
  // los QR se dibujan recién al abrir la fila
  if (open) $$('[data-qr]', row).forEach((el) => { if (!el.firstChild) el.innerHTML = qrSVG(el.dataset.qr); });
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
              <span class="ev__tiers">${e.tiers.map((t) => `<span class="${t.is_active ? '' : 'off'}">${esc(t.name)} ${money(t.price)}${t.door_only ? ' · puerta' : ''}</span>`).join('') || '<span>Sin tramos</span>'}</span>
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
      { name: 'Preventa 1', price: 4000, capacity: 10, max_per_order: 1, is_active: true },
      { name: 'Preventa 2', price: 5000, capacity: 100, max_per_order: 1, is_active: true },
      { name: 'Puerta', price: 6000, capacity: null, max_per_order: null, door_only: true, is_active: true },
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
        <div class="block__h"><div><h2>Entradas y precios</h2><p>Se venden en orden: al agotarse el cupo de un tramo se abre el siguiente. El cupo no se muestra al público. Máx. por compra en 1 = una entrada por persona. "Solo puerta" = se muestra el precio pero no se vende en la web (efectivo en la entrada). Desactiva un tramo para cerrarlo a mano.</p></div>
          <button type="button" class="btn btn--quiet btn--sm" data-add-tier>${icon('plus')}Agregar tramo</button>
        </div>
        <div class="tier-rows">
          ${tiers.map((t, i) => `
            <div class="tier-row" data-ti="${i}">
              <label class="field"><span>Nombre</span><input class="input" data-tf="name" value="${esc(t.name)}" /></label>
              <label class="field"><span>Precio (CLP)</span><span class="money-in"><input class="input" data-tf="price" inputmode="numeric" value="${t.price ?? ''}" /></span></label>
              <label class="field"><span>Cupo</span><input class="input" data-tf="capacity" inputmode="numeric" placeholder="∞" value="${t.capacity ?? ''}" /></label>
              <label class="field"><span>Máx. por compra</span><input class="input" data-tf="max_per_order" inputmode="numeric" placeholder="10" value="${t.max_per_order ?? ''}" /></label>
              <div class="field sw"><span>Solo puerta</span><label class="switch" title="Se vende solo en la entrada, en efectivo. No se puede comprar en la web."><input type="checkbox" data-tf="door_only" ${t.door_only ? 'checked' : ''} /><i></i></label></div>
              <div class="field sw"><span>Activo</span><label class="switch" title="Tramo activo"><input type="checkbox" data-tf="is_active" ${t.is_active ? 'checked' : ''} /><i></i></label></div>
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
    const mx = parseInt($('[data-tf=max_per_order]', row).value.replace(/\D/g, ''), 10);
    t.max_per_order = Number.isFinite(mx) && mx >= 1 && mx < 10 ? mx : null;
    t.is_active = $('[data-tf=is_active]', row).checked;
    t.door_only = $('[data-tf=door_only]', row).checked;
  });
}

function bindEditor(ed) {
  const form = $('[data-ev-form]', ed);
  $$('[data-back]', ed).forEach((b) => b.addEventListener('click', closeEditor));
  $('[data-add-tier]', ed).addEventListener('click', () => {
    readForm(form);
    draft.tiers.push({ name: '', price: '', capacity: null, max_per_order: null, is_active: true });
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
