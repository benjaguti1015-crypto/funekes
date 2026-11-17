const TZ = 'America/Santiago';

const clp = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
export const money = (n) => clp.format(n || 0);

const parts = (iso, opts) => new Intl.DateTimeFormat('es-CL', { timeZone: TZ, ...opts }).format(new Date(iso));

/** "Sábado 12 de diciembre" */
export const longDate = (iso) => {
  const s = parts(iso, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** "SÁB 12 DIC" */
export const shortDate = (iso) =>
  parts(iso, { weekday: 'short', day: 'numeric', month: 'short' }).replace(/[.,]/g, '').toUpperCase();
/** "31 OCT 2026" */
export const stampDate = (iso) =>
  parts(iso, { day: 'numeric', month: 'short', year: 'numeric' }).replace(/[.,]/g, '').replace(/ de /g, ' ').toUpperCase();
/** "13 nov · 15:42" */
export const dateTime = (iso) =>
  parts(iso, { day: 'numeric', month: 'short' }).replace('.', '') + ' · ' + parts(iso, { hour: '2-digit', minute: '2-digit', hour12: false });

/** valor para <input type="datetime-local"> en hora de Chile */
export const toLocalInput = (iso) => {
  if (!iso) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};
/** <input type="datetime-local"> (hora de Chile) → ISO UTC */
export const fromLocalInput = (val) => {
  // Chile continental: UTC-3 en verano, UTC-4 en invierno. Probamos ambos y elegimos el que calza.
  for (const off of ['-03:00', '-04:00']) {
    const iso = new Date(`${val}:00${off}`).toISOString();
    if (toLocalInput(iso) === val) return iso;
  }
  return new Date(`${val}:00-03:00`).toISOString();
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const slugify = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export const isPast = (ev) => new Date(ev.starts_at).getTime() < Date.now() - 12 * 3600 * 1000;

export async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  if (btn) {
    btn.dataset.copied = 'true';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => delete btn.dataset.copied, 1400);
  }
}

let toastEl;
export function toast(msg, kind = 'ok') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind;
  toastEl.dataset.show = 'true';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.dataset.show = 'false'), 2600);
}
