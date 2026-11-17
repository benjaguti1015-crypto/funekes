import { DEMO, getEvents, getSettings, createOrder } from './data.js';
import { money, longDate, shortDate, stampDate, esc, isPast, copy, toast } from './util.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

const state = {
  event: null,
  settings: {},
  tierId: null,
  qty: 1,
  attendees: [],
  accept: false, // aceptó términos y privacidad (se pide en cada compra)
  step: 1,
  order: null,
  busy: false,
};

/** "Chao Clases 2026" → último token numérico en acento (como en la referencia) */
function titleHTML(title) {
  const m = String(title).match(/^(.*?)(\s+\d{2,4})$/);
  return m ? `${esc(m[1])}<span class="accent">${esc(m[2])}</span>` : esc(title);
}

/**
 * Venta escalonada: solo se vende el primer tramo activo que no esté agotado.
 * Los anteriores quedan "agotada" y los siguientes "pronto". Nunca se muestra el cupo.
 */
function tierState(ev, t) {
  if (t.door_only) return t.is_active ? 'puerta' : 'agotada'; // solo en la entrada, en efectivo
  if (!t.is_active || t.sold_out) return 'agotada';
  return ev.tiers.find((x) => x.is_active && !x.sold_out && !x.door_only) === t ? 'venta' : 'pronto';
}
const onSale = (ev) => ev.tiers.find((t) => tierState(ev, t) === 'venta');
const doorTier = (ev) => ev.tiers.find((t) => tierState(ev, t) === 'puerta');
const STATE_TAG = { venta: '', agotada: ' · agotada', pronto: ' · pronto', puerta: ' · efectivo' };
const STATE_LABEL = { venta: 'Disponible', agotada: 'Agotada', pronto: 'Próximamente', puerta: 'Solo en la entrada del evento, en efectivo' };

// ───────────────────────── RENDER LANDING ─────────────────────────

function renderStrip(ev) {
  const strip = $('[data-strip]');
  if (!ev) { strip.hidden = true; return; }
  $('[data-strip-title]').textContent = ev.title.toUpperCase();
  $('[data-strip-date]').textContent = shortDate(ev.starts_at);
}

function flyerHTML(ev) {
  const words = ev.title.split(/\s+/);
  const lines = words.map((w, i) => (/^\d+$/.test(w) && i === words.length - 1 ? `<span class="o">${esc(w)}</span>` : esc(w)));
  return `
    <div class="flyer" role="img" aria-label="Afiche de ${esc(ev.title)}">
      <div class="flyer__top"><span>Funekes presenta</span><span>${esc(ev.location.split(',')[0])}</span></div>
      <div class="flyer__title">${lines.join('<br>')}</div>
      <div class="flyer__bot">
        <div class="flyer__date">${esc(shortDate(ev.starts_at))}<small>${esc(ev.format_label || '')}</small></div>
        <svg class="flyer__crown" aria-hidden="true"><use href="#i-crown"/></svg>
      </div>
    </div>`;
}

function renderEvent(ev) {
  const box = $('[data-event]');
  box.classList.remove('event--loading');
  box.removeAttribute('aria-busy');
  if (!ev) {
    box.className = 'empty';
    box.innerHTML = 'Pronto anunciamos la próxima fecha. Síguenos en Instagram para enterarte primero.';
    return;
  }
  const first = onSale(ev);
  const door = doorTier(ev);
  state.tierId = first?.id ?? null;
  const note = first
    ? `Pago por transferencia: te enviamos los datos por WhatsApp. Cuando validamos el pago te mandamos tu entrada con código QR.${door ? ` En puerta: ${money(door.price)}, solo efectivo.` : ''}`
    : door
      ? `Las preventas se agotaron. Quedan entradas en la puerta del evento a ${money(door.price)}, solo en efectivo.`
      : 'Ya no quedan entradas para esta fecha.';

  box.innerHTML = `
    <div class="event__media">
      ${ev.cover_url ? `<img src="${esc(ev.cover_url)}" alt="${esc(ev.title)}" loading="lazy" />` : flyerHTML(ev)}
    </div>
    <div class="event__info">
      <p class="event__format">${esc(ev.format_label || '')}</p>
      <h3 class="event__title display">${titleHTML(ev.title)}</h3>
      ${ev.subtitle ? `<p class="event__sub">${esc(ev.subtitle)}</p>` : ''}
      <ul class="event__meta">
        <li>${icon('cal')}<span>${esc(longDate(ev.starts_at))}</span><a href="#" class="save" data-ics>Guardar fecha</a></li>
        <li>${icon('pin')}<span>${esc(ev.location)}</span></li>
        <li>${icon('clock')}<span>${esc(ev.venue || 'Recinto y horario por anunciar')}</span></li>
      </ul>
      <p class="event__tlabel">Entradas</p>
      <div class="tiers" role="radiogroup" aria-label="Tramo de entrada" style="--n:${ev.tiers.length || 1}">
        ${ev.tiers.map((t) => { const st = tierState(ev, t); return `
          <button class="tier" role="radio" data-tier="${t.id}" data-state="${st}"
            aria-checked="${t.id === state.tierId}" ${st === 'venta' ? '' : 'aria-disabled="true"'}
            ${t.id === state.tierId ? 'tabindex="0"' : 'tabindex="-1"'}>
            <small>${esc(t.name)}${STATE_TAG[st]}</small>
            <b>${money(t.price)}</b>
          </button>`; }).join('')}
      </div>
      <button class="btn btn--primary event__buy" data-buy ${first ? '' : 'disabled'}>
        <span>${icon('ticket')}${first ? 'Comprar entrada' : door ? 'Preventas agotadas' : 'Entradas agotadas'}</span>
        ${icon('ne', 'arrow arrow--ne')}
      </button>
      <p class="event__note">${note}</p>
      <p class="event__legal">Solo mayores de 18 años. Entradas sin devolución, con traspaso por WhatsApp. <a href="terminos.html">Términos</a> · <a href="privacidad.html">Privacidad</a></p>
    </div>`;

  // selección de tramo (radios accesibles con flechas)
  const radios = $$('.tier', box);
  const select = (btn) => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    state.tierId = btn.dataset.tier;
    radios.forEach((r) => {
      const on = r === btn;
      r.setAttribute('aria-checked', on);
      r.tabIndex = on ? 0 : -1;
    });
  };
  radios.forEach((r) => {
    r.addEventListener('click', () => select(r));
    r.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const enabled = radios.filter((x) => x.getAttribute('aria-disabled') !== 'true');
      const i = enabled.indexOf(r);
      const next = enabled[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length];
      select(next);
      next.focus();
    });
  });
  $('[data-ics]', box).addEventListener('click', (e) => { e.preventDefault(); downloadICS(ev); });
}

function renderArchive(events) {
  const box = $('[data-archive]');
  const past = events.filter(isPast).reverse();
  if (!past.length) {
    box.innerHTML = `<p class="empty">Acá van a quedar las fechas que ya pasaron.</p>`;
    return;
  }
  // posición del ícono "ampliar" quemado en las capturas originales de demo
  const EX = {
    'halloween-afiche.jpg': '--ex-top:1.9%;--ex-right:2.5%;--ex-w:9.3%',
    'halloween-gracias.jpg': '--ex-top:1.9%;--ex-right:3.6%;--ex-w:12.3%',
  };
  const shot = (src, cap) => {
    const ex = EX[src.split('/').pop()] || '';
    return `
      <button class="shot" data-lb="${esc(src)}" data-cap="${esc(cap)}" aria-label="Ampliar: ${esc(cap)}">
        <span class="shot__img" style="${ex}">
          <img src="${esc(src)}" alt="${esc(cap)}" loading="lazy" />
          <span class="shot__ex" aria-hidden="true">${icon('expand')}</span>
        </span>
        <span class="shot__cap">${esc(cap)} ${icon('ne')}</span>
      </button>`;
  };
  box.innerHTML = past.map((ev) => {
    const imgs = [ev.poster_url && [ev.poster_url, `Afiche de ${ev.title.replace(/funekes/i, '').trim()}`], ev.recap_url && [ev.recap_url, 'Gracias, Funekes Family']].filter(Boolean);
    const venue = (ev.venue || ev.location).split(',')[0];
    return `
      <article class="arch reveal">
        <div>
          <p class="arch__stamp">${esc(stampDate(ev.starts_at))}<i>•</i>${esc(venue)}, ${esc(ev.location.split(',')[0])}</p>
          <h3 class="arch__title display">${esc(ev.title)}</h3>
          ${ev.attendance ? `<p class="arch__stat"><b>${ev.attendance}+</b><span>asistentes</span></p>` : ''}
          ${ev.recap_text ? `<p class="arch__p">${esc(ev.recap_text)}</p>` : ''}
        </div>
        ${imgs.length ? `<div class="arch__media" style="--cols:${imgs.length === 2 ? '389fr 294fr' : 'minmax(0,420px)'}">${imgs.map(([s, c]) => shot(s, c)).join('')}</div>` : ''}
      </article>`;
  }).join('');
  observeReveals();
}

function renderContact(s) {
  const ig = (s.instagram || '99funekes').replace(/^@/, '');
  const igA = $('[data-ig]');
  igA.href = `https://instagram.com/${ig}`;
  $('[data-ig-handle]').textContent = `@${ig}`;
  const wa = (s.whatsapp || '').replace(/\D/g, '');
  const waA = $('[data-wa]');
  if (wa) waA.href = `https://wa.me/${wa}`;
  else waA.hidden = true;
}

// ───────────────────────── CALENDARIO ─────────────────────────

function downloadICS(ev) {
  const d = new Date(ev.starts_at);
  const end = new Date(d.getTime() + 6 * 3600e3);
  const f = (x) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Funekes//ES', 'BEGIN:VEVENT',
    `UID:${ev.id}@funekes`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(d)}`, `DTEND:${f(end)}`,
    `SUMMARY:${ev.title} · Funekes`, `LOCATION:${ev.venue ? ev.venue + ', ' : ''}${ev.location}`,
    `DESCRIPTION:${ev.subtitle || ''}`, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${ev.slug || 'funekes'}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ───────────────────────── CHECKOUT ─────────────────────────

const sheet = $('[data-sheet]');
const body = $('[data-sheet-body]');
const foot = $('[data-sheet-foot]');
let lastFocus = null;

function openSheet() {
  const ev = state.event;
  if (!ev || !onSale(ev)) return;
  state.tierId = onSale(ev).id;
  state.step = 1;
  state.order = null;
  state.accept = false;
  lastFocus = document.activeElement;
  $('[data-sheet-event]').textContent = `${ev.title} · ${shortDate(ev.starts_at)}`;
  renderStep(0);
  sheet.hidden = false;
  document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(() => requestAnimationFrame(() => (sheet.dataset.open = 'true')));
}

function closeSheet() {
  if (sheet.hidden) return;
  sheet.dataset.closing = 'true';
  sheet.dataset.open = 'false';
  const panel = $('.sheet__panel', sheet);
  const done = () => {
    sheet.hidden = true;
    delete sheet.dataset.closing;
    document.documentElement.style.overflow = '';
    lastFocus?.focus?.();
  };
  const t = setTimeout(done, 260);
  panel.addEventListener('transitionend', () => { clearTimeout(t); done(); }, { once: true });
  // si la orden ya se creó, el siguiente "Comprar" parte de cero
  if (state.order) { state.attendees = []; state.qty = 1; }
}

/**
 * Vuelve a leer el evento (un tramo pudo agotarse mientras tanto).
 * Devuelve true si cambió el tramo en venta.
 */
async function syncEvent() {
  const prev = state.tierId;
  try {
    const ev = (await getEvents()).find((e) => e.id === state.event.id);
    if (!ev) return false;
    state.event = ev;
    renderEvent(ev); // deja state.tierId en el tramo en venta
  } catch { return false; }
  return state.tierId !== prev;
}

function setSteps() {
  $$('[data-step-dot]').forEach((li) => {
    const n = +li.dataset.stepDot;
    li.dataset.state = n < state.step ? 'done' : n === state.step ? 'current' : 'todo';
    if (n === state.step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}

function tier() { return state.event.tiers.find((t) => t.id === state.tierId); }
/** tope de entradas por compra del tramo en venta (las preventas son 1 por persona) */
const maxQty = () => Math.min(10, tier()?.max_per_order || 10);

function renderStep(dir = 1) {
  body.style.setProperty('--dir', `${dir * 12}px`);
  setSteps();
  if (state.step === 1) step1();
  if (state.step === 2) step2();
  if (state.step === 3) step3();
  body.scrollTop = 0;
}

function step1() {
  const ev = state.event;
  const max = maxQty();
  state.qty = Math.min(state.qty, max);
  $('[data-sheet-title]').textContent = max === 1 ? 'Tu entrada' : 'Elige tus entradas';
  body.innerHTML = `
    <div>
      <div class="opt-list" role="radiogroup" aria-label="Tramo">
        ${ev.tiers.map((t) => { const st = tierState(ev, t); return `
          <button class="opt" role="radio" data-opt="${t.id}" aria-checked="${t.id === state.tierId}" ${st === 'venta' ? '' : 'aria-disabled="true"'}>
            <span class="opt__radio"></span>
            <span><b>${esc(t.name)}</b><small>${STATE_LABEL[st]}</small></span>
            <span class="opt__price">${money(t.price)}</span>
          </button>`; }).join('')}
      </div>
      <div class="qty">
        <div class="qty__label"><b>Cantidad</b><small>${max === 1 ? '1 entrada por persona en este tramo' : `Máximo ${max} por compra`}</small></div>
        <div class="stepper">
          <button data-dec aria-label="Quitar una entrada">${icon('minus')}</button>
          <output aria-live="polite" data-qty>${state.qty}</output>
          <button data-inc aria-label="Agregar una entrada">${icon('plus')}</button>
        </div>
      </div>
      <div class="total-row"><span>Total</span><b data-total></b></div>
    </div>`;
  foot.innerHTML = `<button class="btn btn--primary" data-next>Continuar ${icon('right', 'arrow')}</button>`;

  const sync = () => {
    $('[data-qty]', body).textContent = state.qty;
    $('[data-total]', body).textContent = money(tier().price * state.qty);
    $('[data-dec]', body).disabled = state.qty <= 1;
    $('[data-inc]', body).disabled = state.qty >= max;
  };
  $$('[data-opt]', body).forEach((b) => b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    state.tierId = b.dataset.opt;
    $$('[data-opt]', body).forEach((x) => x.setAttribute('aria-checked', x === b));
    // reflejar en la tarjeta del evento
    $$('.tier').forEach((x) => x.setAttribute('aria-checked', x.dataset.tier === state.tierId));
    sync();
  }));
  $('[data-dec]', body).addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); sync(); });
  $('[data-inc]', body).addEventListener('click', () => { state.qty = Math.min(max, state.qty + 1); sync(); });
  $('[data-next]', foot).addEventListener('click', () => { state.step = 2; renderStep(1); });
  sync();
}

function step2() {
  const t = tier();
  $('[data-sheet-title]').textContent = state.qty > 1 ? `Datos de las ${state.qty} entradas` : 'Datos de la entrada';
  // conservar lo ya escrito si cambia la cantidad
  state.attendees = Array.from({ length: state.qty }, (_, i) => state.attendees[i] || { first_name: '', last_name: '' });

  body.innerHTML = `
    <form novalidate data-form>
      <p class="att-intro">Cada entrada es nominativa: necesitamos nombre y apellido de cada persona.</p>
      ${state.attendees.map((a, i) => `
        <fieldset class="att">
          <legend>Entrada ${i + 1} · ${esc(t.name)}</legend>
          <div class="att__grid">
            <label class="field"><span>Nombre</span>
              <input class="input" name="first_name" data-i="${i}" maxlength="60" autocomplete="${i ? 'off' : 'given-name'}" value="${esc(a.first_name)}" required /></label>
            <label class="field"><span>Apellido</span>
              <input class="input" name="last_name" data-i="${i}" maxlength="60" autocomplete="${i ? 'off' : 'family-name'}" value="${esc(a.last_name)}" required /></label>
          </div>
        </fieldset>`).join('')}
      <p class="att-legal">Tu nombre y apellido se usan solo para saber quién compró la entrada.</p>
      <label class="accept" data-accept-box>
        <input type="checkbox" name="accept" data-accept ${state.accept ? 'checked' : ''} />
        <span class="accept__box" aria-hidden="true">${icon('check')}</span>
        <span>Soy mayor de 18 años y acepto los
          <a href="terminos.html" target="_blank" rel="noopener">Términos y condiciones</a> (entrada sin devolución, con traspaso por WhatsApp) y la
          <a href="privacidad.html" target="_blank" rel="noopener">Política de privacidad</a>.</span>
      </label>
      <div data-form-error></div>
      <button type="submit" hidden></button>
    </form>`;
  foot.innerHTML = `
    <button class="btn btn--quiet" data-back aria-label="Volver">${icon('left')}</button>
    <button class="btn btn--primary" data-submit>Confirmar compra · ${money(t.price * state.qty)}</button>`;

  const form = $('[data-form]', body);
  form.addEventListener('input', (e) => {
    const el = e.target;
    if (el.name === 'accept') {
      state.accept = el.checked;
      if (el.checked) {
        $('[data-accept-box]', body).removeAttribute('data-invalid');
        $('[data-form-error]', body).innerHTML = '';
      }
      return;
    }
    state.attendees[+el.dataset.i][el.name] = el.value;
    if (el.getAttribute('aria-invalid') === 'true' && valid(el)) el.removeAttribute('aria-invalid');
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('[data-back]', foot).addEventListener('click', () => { state.step = 1; renderStep(-1); });
  $('[data-submit]', foot).addEventListener('click', submit);
  setTimeout(() => $('input', body)?.focus({ preventScroll: true }), 280);
}

const valid = (el) => el.value.trim().length > 0;

async function submit() {
  if (state.busy) return;
  const inputs = $$('input[data-i]', body);
  let firstBad = null;
  inputs.forEach((el) => {
    const ok = valid(el);
    el.setAttribute('aria-invalid', String(!ok));
    if (!ok && !firstBad) firstBad = el;
  });
  const errBox = $('[data-form-error]', body);
  if (firstBad) {
    errBox.innerHTML = `<p class="form-error" role="alert">Revisa los campos marcados en rojo.</p>`;
    firstBad.focus();
    return;
  }
  // sin el clic en "acepto" no se crea la orden
  const accept = $('[data-accept]', body);
  if (!accept.checked) {
    $('[data-accept-box]', body).dataset.invalid = 'true';
    errBox.innerHTML = `<p class="form-error" role="alert">Para comprar tienes que aceptar los Términos y condiciones y la Política de privacidad.</p>`;
    accept.focus();
    return;
  }
  errBox.innerHTML = '';
  const btn = $('[data-submit]', foot);
  const label = btn.innerHTML;
  state.busy = true;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> Creando orden…`;
  try {
    state.order = await createOrder(state.tierId, state.attendees.map((a) => ({ ...a })), accept.checked);
    state.step = 3;
    renderStep(1);
    syncEvent(); // esta compra pudo agotar el tramo
  } catch (err) {
    const was = tier()?.name;
    if (await syncEvent()) {
      // el tramo se agotó mientras se llenaba el formulario: volver a elegir con el precio nuevo
      const now = onSale(state.event);
      if (!now) { closeSheet(); toast('Entradas agotadas', 'error'); return; }
      state.step = 1;
      renderStep(-1);
      toast(`${was} se agotó. Ahora está disponible ${now.name}.`, 'error');
      return;
    }
    errBox.innerHTML = `<p class="form-error" role="alert">${esc(err.message || 'No pudimos crear la orden. Intenta de nuevo.')}</p>`;
    btn.disabled = false;
    btn.innerHTML = label;
  } finally {
    state.busy = false;
  }
}

function step3() {
  const o = state.order;
  const s = state.settings;
  $('[data-sheet-title]').textContent = '¡Orden creada!';
  const wa = (s.whatsapp || '').replace(/\D/g, '');
  const names = state.attendees.map((a) => `${a.first_name.trim()} ${a.last_name.trim()}`).join(', ');
  const msg = encodeURIComponent(
    `Hola Funekes! Hice la orden ${o.code}: ${o.quantity} × ${o.tier_name} para ${o.event_title} (${names}). ` +
    `Total ${money(o.total)}. ¿Me pasan los datos para transferir?`
  );
  const waUrl = wa ? `https://wa.me/${wa}?text=${msg}` : null;

  body.innerHTML = `
    <div>
      <div class="done-head">
        <span class="done-check"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
        <div>
          <p><b>${o.quantity} × ${esc(o.tier_name)}</b> · ${esc(o.event_title)}</p>
          <span class="status-pill">Pendiente de pago</span>
        </div>
      </div>
      <div class="paybox">
        <div class="paybox__total"><span>Total a transferir</span><b>${money(o.total)}</b></div>
        <div class="payrow payrow--code">
          <div><small>Tu código de orden</small><span>${esc(o.code)}</span></div>
          <button class="iconbtn copy-btn" data-copy="${esc(o.code)}" aria-label="Copiar código">
            ${icon('copy', 'ic-copy')}${icon('check', 'ic-check')}
          </button>
        </div>
      </div>
      <ol class="howto">
        <li><span>Escríbenos por <b>WhatsApp</b> con tu código. El mensaje ya va listo.</span></li>
        <li><span>Te enviamos los <b>datos de transferencia</b>. Transfiere <b>${money(o.total)}</b> y manda el comprobante por el mismo chat. Tienes <b>24 horas</b>: después la reserva se cancela sola.</span></li>
        <li><span>Cuando validemos el pago te mandamos por WhatsApp tu <b>entrada en PDF con código QR</b>. Ese QR es el que se escanea en la puerta.</span></li>
      </ol>
    </div>`;
  foot.innerHTML = waUrl
    ? `<button class="btn btn--quiet" data-close-done>Cerrar</button>
       <a class="btn btn--primary" href="${waUrl}" target="_blank" rel="noopener">${icon('wa')}Pedir datos por WhatsApp</a>`
    : `<button class="btn btn--primary" data-close-done>Listo</button>`;
  $$('[data-copy]', body).forEach((b) => b.addEventListener('click', () => { copy(b.dataset.copy, b); toast('Copiado'); }));
  $('[data-close-done]', foot).addEventListener('click', closeSheet);
}

// ───────────────────────── LIGHTBOX ─────────────────────────

const lb = $('[data-lightbox]');
function openLB(src, cap) {
  $('[data-lb-img]').src = src;
  $('[data-lb-img]').alt = cap;
  $('[data-lb-cap]').textContent = cap;
  lastFocus = document.activeElement;
  lb.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => (lb.dataset.open = 'true')));
  $('.lightbox__x', lb).focus();
}
function closeLB() {
  if (lb.hidden) return;
  lb.dataset.open = 'false';
  setTimeout(() => { lb.hidden = true; lastFocus?.focus?.(); }, 200);
}

// ───────────────────────── REVEAL ─────────────────────────

let io;
function observeReveals() {
  if (!('IntersectionObserver' in window)) { $$('.reveal').forEach((el) => el.classList.add('is-in')); return; }
  io ||= new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -80px 0px' });
  $$('.reveal:not(.is-in)').forEach((el) => io.observe(el));
}

// ───────────────────────── INIT ─────────────────────────

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-buy]')) {
    e.preventDefault();
    if (state.event && onSale(state.event)) openSheet();
    else document.getElementById('evento').scrollIntoView();
  }
  if (e.target.closest('[data-close]')) closeSheet();
  const shot = e.target.closest('[data-lb]');
  if (shot) openLB(shot.dataset.lb, shot.dataset.cap);
  if (e.target.closest('[data-lb-close]')) closeLB();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeLB(); closeSheet(); }
  // trampa de foco simple dentro del checkout
  if (e.key === 'Tab' && !sheet.hidden) {
    const f = $$('button:not([disabled]):not([hidden]), input, a[href]', sheet).filter((x) => x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
});

async function init() {
  if (DEMO) {
    const b = document.createElement('div');
    b.className = 'demo-badge';
    b.textContent = 'Modo demo';
    document.body.appendChild(b);
  }
  try {
    const [events, settings] = await Promise.all([getEvents(), getSettings()]);
    state.settings = settings || {};
    const upcoming = events.filter((e) => !isPast(e));
    state.event = upcoming[0] || null;
    renderStrip(state.event);
    renderEvent(state.event);
    renderArchive(events);
    renderContact(state.settings);
    $('[data-event]').classList.add('reveal');
    observeReveals();
  } catch (err) {
    console.error(err);
    const box = $('[data-event]');
    box.className = 'empty';
    box.textContent = 'No pudimos cargar el evento. Recarga la página en un momento.';
    toast('Error de conexión', 'error');
  }
}
init();
