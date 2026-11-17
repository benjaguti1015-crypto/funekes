// Capa de datos: Supabase si hay credenciales, si no MODO DEMO (localStorage).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { loadScript } from './util.js';

export const DEMO = !SUPABASE_URL || !SUPABASE_ANON_KEY;

// La librería de Supabase va dentro del proyecto (js/vendor), no en un CDN externo:
// así nadie fuera de este sitio puede cambiar el código que maneja la sesión del admin.
let sb = null;
function client() {
  sb ||= loadScript(new URL('./vendor/supabase.js', import.meta.url).href)
    .then(() => window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
  return sb;
}
const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

// ───────────────────────── DEMO ─────────────────────────
const KEY = 'funekes-demo-v4';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

function seed() {
  const chao = uid(), hall = uid();
  const people = [
    ['Catalina', 'Muñoz'], ['Benjamín', 'Soto'], ['Javiera', 'Rojas'], ['Matías', 'Contreras'], ['Antonia', 'Fuentes'],
  ];
  const tiers = [
    { id: uid(), event_id: chao, name: 'Preventa 1', price: 4000, capacity: 10, max_per_order: 1, sort_order: 1, is_active: true },
    { id: uid(), event_id: chao, name: 'Preventa 2', price: 5000, capacity: 100, max_per_order: 1, sort_order: 2, is_active: false },
    { id: uid(), event_id: chao, name: 'Puerta', price: 6000, capacity: null, max_per_order: null, door_only: true, sort_order: 3, is_active: true },
  ];
  const mk = (code, tier, who, status, hoursAgo) => {
    const created = new Date(Date.now() - hoursAgo * 3600e3).toISOString();
    return {
      id: uid(), code, event_id: chao, tier_id: tier.id, tier_name: tier.name,
      buyer_name: `${who[0][0]} ${who[0][1]}`,
      quantity: who.length, unit_price: tier.price, total: tier.price * who.length,
      status, created_at: created, paid_at: status === 'pagado' ? created : null,
      expires_at: new Date(new Date(created).getTime() + TTL).toISOString(),
      tickets: who.map((p) => ({ id: uid(), first_name: p[0], last_name: p[1], qr_code: genCode(), checked_in_at: null })),
    };
  };
  return {
    settings: { whatsapp: '+56959897604', instagram: '99funekes' },
    events: [
      {
        id: chao, slug: 'chao-clases-2026', title: 'Chao Clases 2026',
        subtitle: 'Una noche con DJs para despedir el año de clases.', format_label: 'Formato discoteca',
        starts_at: '2026-12-13T02:00:00.000Z', location: 'Tomé, Biobío', venue: 'Recinto y horario por anunciar',
        cover_url: null, is_published: true,
      },
      {
        id: hall, slug: 'halloween-funekes-2026', title: 'Halloween Funekes', subtitle: null,
        format_label: 'Formato discoteca', starts_at: '2026-11-01T00:00:00.000Z', location: 'Tomé, Biobío',
        venue: 'Círculo Naval, Sotomayor 820', poster_url: 'assets/img/halloween-afiche.jpg',
        recap_url: 'assets/img/halloween-gracias.jpg', attendance: 500,
        recap_text: 'Disfraces, reggaetón y una pista llena. Gracias a todos los que llenaron el Círculo Naval.',
        is_published: true,
      },
    ],
    tiers,
    orders: [
      mk('FNK-7Q2KX', tiers[0], [people[0]], 'pagado', 70),
      mk('FNK-M4RT9', tiers[0], [people[2]], 'pagado', 52),
      mk('FNK-H8PLC', tiers[0], [people[3]], 'pendiente', 5),
    ],
  };
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  const s = seed();
  save(s);
  return s;
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}
const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Código de entrada como el de la base: K7QM-2XPA-9HTD */
function genCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const c = Array.from(b, (x) => CODE_ALPHA[x % 32]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}
// Una orden pendiente reserva cupo 24 horas; después vence sola (igual que en la base).
const TTL = 24 * 3600e3;
const EXPIRED_NOTE = 'Venció: pasaron 24 horas sin pago';
const demoLive = (o) => o.status === 'pagado' || (o.status === 'pendiente' && (!o.expires_at || new Date(o.expires_at) > Date.now()));
function demoExpire(s) {
  let n = 0;
  for (const o of s.orders) {
    if (o.status === 'pendiente' && o.expires_at && new Date(o.expires_at) <= Date.now()) {
      o.status = 'cancelado';
      o.notes = EXPIRED_NOTE;
      n++;
    }
  }
  if (n) save(s);
}
const demoSold = (s, tierId) =>
  s.orders.filter((o) => o.tier_id === tierId && demoLive(o)).reduce((n, o) => n + o.quantity, 0);
const demoSoldOut = (s, t) => !!t.capacity && demoSold(s, t.id) >= t.capacity;

// ───────────────────────── API PÚBLICA ─────────────────────────

export async function getSettings() {
  if (DEMO) return load().settings;
  const c = await client();
  return unwrap(await c.from('settings').select('*').eq('id', 1).maybeSingle()) || {};
}

/**
 * Eventos con sus tramos, ordenados por fecha.
 * Público: cada tramo trae `sold_out` pero NO el cupo ni lo vendido.
 * Admin (includeHidden): tramos completos, con cupo.
 */
export async function getEvents({ includeHidden = false } = {}) {
  if (DEMO) {
    const s = load();
    const pub = ({ capacity, ...t }) => ({ ...t, sold_out: demoSoldOut(s, { capacity, ...t }) });
    return s.events
      .filter((e) => includeHidden || e.is_published)
      .map((e) => ({
        ...e,
        tiers: s.tiers.filter((t) => t.event_id === e.id).sort((a, b) => a.sort_order - b.sort_order)
          .map((t) => (includeHidden ? { ...t } : pub(t))),
      }))
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  }
  const c = await client();
  if (includeHidden) {
    const rows = unwrap(await c.from('events').select('*, tiers:ticket_tiers(*)').order('starts_at', { ascending: true }));
    rows.forEach((e) => e.tiers.sort((a, b) => a.sort_order - b.sort_order));
    return rows;
  }
  const [events, tiers] = await Promise.all([
    c.from('events').select('*').order('starts_at', { ascending: true }),
    c.from('tiers_public').select('*').order('sort_order', { ascending: true }),
  ]).then((r) => r.map(unwrap));
  return events.map((e) => ({ ...e, tiers: tiers.filter((t) => t.event_id === e.id) }));
}

/**
 * attendees: [{first_name,last_name}] → {code,total,quantity,unit_price,tier_name,event_title}
 * accepted: el comprador marcó la casilla de términos y privacidad (obligatorio).
 */
export async function createOrder(tierId, attendees, accepted = false) {
  if (DEMO) {
    await wait(600);
    const s = load();
    demoExpire(s);
    const tier = s.tiers.find((t) => t.id === tierId);
    if (!tier || !tier.is_active) throw new Error('Este tramo de entradas no está disponible');
    if (tier.door_only) throw new Error(`${tier.name} se vende solo en la entrada del evento, en efectivo`);
    if (!accepted) throw new Error('Para comprar tienes que aceptar los Términos y condiciones y la Política de privacidad');
    if (attendees.length < 1 || attendees.length > 10) throw new Error('Puedes comprar entre 1 y 10 entradas por orden');
    if (attendees.length > (tier.max_per_order || 10)) {
      throw new Error(tier.max_per_order === 1 ? `${tier.name} es 1 entrada por persona` : `En ${tier.name} puedes comprar hasta ${tier.max_per_order} entradas por orden`);
    }
    for (const a of attendees) {
      if (!a.first_name.trim() || !a.last_name.trim()) throw new Error('Cada entrada necesita nombre y apellido');
      if (a.first_name.trim().length > 60 || a.last_name.trim().length > 60) throw new Error('El nombre y el apellido pueden tener hasta 60 caracteres cada uno');
    }
    const earlierOpen = s.tiers.some((p) => p.event_id === tier.event_id && p.is_active && !p.door_only && p.sort_order < tier.sort_order && !demoSoldOut(s, p));
    if (earlierOpen) throw new Error(`${tier.name} todavía no está a la venta`);
    if (tier.capacity) {
      const sold = demoSold(s, tier.id);
      if (sold >= tier.capacity) throw new Error(`${tier.name} se agotó`);
      if (sold + attendees.length > tier.capacity) throw new Error(`No quedan suficientes entradas en ${tier.name} para esa cantidad. Prueba con menos.`);
    }
    let code;
    do {
      code = 'FNK-' + Array.from({ length: 5 }, () => CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)]).join('');
    } while (s.orders.some((o) => o.code === code));
    const ev = s.events.find((e) => e.id === tier.event_id);
    const clean = attendees.map((a) => ({ id: uid(), first_name: a.first_name.trim(), last_name: a.last_name.trim(), qr_code: genCode(), checked_in_at: null }));
    s.orders.push({
      id: uid(), code, event_id: ev.id, tier_id: tier.id, tier_name: tier.name,
      buyer_name: `${clean[0].first_name} ${clean[0].last_name}`,
      quantity: clean.length, unit_price: tier.price, total: tier.price * clean.length,
      status: 'pendiente', created_at: new Date().toISOString(), paid_at: null, terms_accepted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + TTL).toISOString(), tickets: clean,
    });
    save(s);
    return { code, event_title: ev.title, tier_name: tier.name, quantity: clean.length, unit_price: tier.price, total: tier.price * clean.length };
  }
  const c = await client();
  const people = attendees.map((a) => ({ first_name: a.first_name, last_name: a.last_name }));
  const res = await c.rpc('create_order', { p_tier_id: tierId, p_attendees: people, p_accepted: accepted });
  // Compatibilidad: si la base todavía tiene la función anterior (sin p_accepted), se usa esa.
  if (res.error && (res.error.code === 'PGRST202' || /could not find the function/i.test(res.error.message || ''))) {
    return unwrap(await c.rpc('create_order', { p_tier_id: tierId, p_attendees: people }));
  }
  return unwrap(res);
}

// ───────────────────────── ADMIN ─────────────────────────

export async function getAdminSession() {
  if (DEMO) return sessionStorage.getItem('funekes-demo-admin') ? { email: sessionStorage.getItem('funekes-demo-admin') } : null;
  const c = await client();
  const { data } = await c.auth.getSession();
  if (!data.session) return null;
  const ok = unwrap(await c.rpc('is_admin'));
  return ok ? { email: data.session.user.email } : { email: data.session.user.email, notAdmin: true };
}

export async function signIn(email, password) {
  if (DEMO) {
    await wait(400);
    sessionStorage.setItem('funekes-demo-admin', email || 'demo@funekes.cl');
    return { email };
  }
  const c = await client();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos' : error.message);
  const s = await getAdminSession();
  if (s?.notAdmin) {
    await c.auth.signOut();
    throw new Error('Esta cuenta no tiene permisos de administrador');
  }
  return s;
}

// ───────────────────────── PUERTA (guardia o admin) ─────────────────────────

/** {email, role: 'admin' | 'guard'} · {email, notStaff: true} · null */
export async function getDoorSession() {
  if (DEMO) {
    const email = sessionStorage.getItem('funekes-demo-door') || sessionStorage.getItem('funekes-demo-admin');
    return email ? { email, role: 'guard' } : null;
  }
  const c = await client();
  const { data } = await c.auth.getSession();
  if (!data.session) return null;
  const role = unwrap(await c.rpc('staff_role'));
  return role ? { email: data.session.user.email, role } : { email: data.session.user.email, notStaff: true };
}

export async function signInDoor(email, password) {
  if (DEMO) {
    await wait(400);
    sessionStorage.setItem('funekes-demo-door', email || 'guardia@funekes.cl');
    return { email, role: 'guard' };
  }
  const c = await client();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos' : error.message);
  const s = await getDoorSession();
  if (!s || s.notStaff) {
    await c.auth.signOut();
    throw new Error('Esta cuenta no tiene permiso para escanear entradas');
  }
  return s;
}

const normCode = (code) => {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}` : null;
};

/**
 * Valida una entrada en puerta y marca el ingreso (una sola vez).
 * → {result: 'ok'|'used'|'unpaid'|'cancelled'|'wrong_event'|'not_found', name?, tier_name?, event_title?, checked_in_at?}
 */
export async function checkIn(code, eventId = null) {
  if (DEMO) {
    await wait(250);
    const s = load();
    const qr = normCode(code);
    const o = qr && s.orders.find((x) => (x.tickets || []).some((t) => t.qr_code === qr));
    if (!o) return { result: 'not_found' };
    const t = o.tickets.find((x) => x.qr_code === qr);
    const info = { name: `${t.first_name} ${t.last_name}`, tier_name: o.tier_name, event_title: s.events.find((e) => e.id === o.event_id)?.title };
    if (eventId && o.event_id !== eventId) return { ...info, result: 'wrong_event' };
    if (o.status === 'cancelado') return { ...info, result: 'cancelled' };
    if (o.status !== 'pagado') return { ...info, result: 'unpaid' };
    if (t.checked_in_at) return { ...info, result: 'used', checked_in_at: t.checked_in_at };
    t.checked_in_at = new Date().toISOString();
    save(s);
    return { ...info, result: 'ok', checked_in_at: t.checked_in_at };
  }
  const c = await client();
  return unwrap(await c.rpc('check_in', { p_code: code, p_event_id: eventId }));
}

/** Personas que ya ingresaron al evento */
export async function doorCount(eventId) {
  if (DEMO) {
    return load().orders.filter((o) => o.event_id === eventId).flatMap((o) => o.tickets || []).filter((t) => t.checked_in_at).length;
  }
  const c = await client();
  return unwrap(await c.rpc('door_count', { p_event_id: eventId }));
}

/** Traspaso: cambia el nombre de la entrada y le genera un QR nuevo (el anterior deja de servir) */
export async function transferTicket(ticketId, firstName, lastName) {
  if (DEMO) {
    const s = load();
    const o = s.orders.find((x) => (x.tickets || []).some((t) => t.id === ticketId));
    const t = o?.tickets.find((x) => x.id === ticketId);
    if (!t) throw new Error('La entrada no existe');
    if (t.checked_in_at) throw new Error('Esta entrada ya se usó para ingresar');
    Object.assign(t, { first_name: firstName.trim(), last_name: lastName.trim(), qr_code: genCode() });
    if (o.quantity === 1) o.buyer_name = `${t.first_name} ${t.last_name}`;
    save(s);
    return { ...t };
  }
  const c = await client();
  return unwrap(await c.rpc('transfer_ticket', { p_ticket_id: ticketId, p_first_name: firstName, p_last_name: lastName }));
}

/** Deshace un ingreso marcado por error (solo admin) */
export async function undoCheckIn(ticketId) {
  if (DEMO) {
    const s = load();
    const t = s.orders.flatMap((o) => o.tickets || []).find((x) => x.id === ticketId);
    if (t) t.checked_in_at = null;
    save(s);
    return;
  }
  const c = await client();
  unwrap(await c.from('tickets').update({ checked_in_at: null, checked_in_by: null }).eq('id', ticketId));
}

export async function signOut() {
  if (DEMO) {
    sessionStorage.removeItem('funekes-demo-door');
    return sessionStorage.removeItem('funekes-demo-admin');
  }
  const c = await client();
  await c.auth.signOut();
}

export async function listOrders() {
  if (DEMO) {
    await wait(200);
    const s = load();
    demoExpire(s);
    return [...s.orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  const c = await client();
  // cancela las pendientes vencidas antes de listar (si la base aún no tiene la función, se ignora)
  await c.rpc('expire_pending_orders').then(() => {}, () => {});
  return unwrap(await c.from('orders').select('*, tickets(*)').order('created_at', { ascending: false }));
}

/** Abre o cierra la venta de un tramo (el siguiente no se abre solo: lo decide el admin). */
export async function setTierActive(tierId, active) {
  if (DEMO) {
    const s = load();
    const t = s.tiers.find((x) => x.id === tierId);
    if (t) t.is_active = !!active;
    save(s);
    return;
  }
  const c = await client();
  unwrap(await c.from('ticket_tiers').update({ is_active: !!active }).eq('id', tierId));
}

export async function setOrderStatus(id, status) {
  if (DEMO) {
    const s = load();
    const o = s.orders.find((x) => x.id === id);
    if (status === 'pendiente' && o.status !== 'pendiente') {
      // reactivar da un plazo nuevo de 24 horas
      o.expires_at = new Date(Date.now() + TTL).toISOString();
      if (o.notes === EXPIRED_NOTE) o.notes = null;
    }
    o.status = status;
    o.paid_at = status === 'pagado' ? new Date().toISOString() : null;
    save(s);
    return o;
  }
  const c = await client();
  return unwrap(await c.from('orders').update({ status }).eq('id', id).select('*, tickets(*)').single());
}

const EVENT_FIELDS = ['slug', 'title', 'subtitle', 'format_label', 'starts_at', 'location', 'venue', 'cover_url',
  'poster_url', 'recap_url', 'attendance', 'recap_text', 'is_published'];

/** Guarda evento + tramos. tiers con id existente se actualizan; sin id se crean; removedTierIds se borran. */
export async function saveEvent(ev, tiers, removedTierIds = []) {
  const row = Object.fromEntries(EVENT_FIELDS.map((k) => [k, ev[k] ?? null]));
  if (DEMO) {
    const s = load();
    let id = ev.id;
    if (id) Object.assign(s.events.find((e) => e.id === id), row);
    else { id = uid(); s.events.push({ id, ...row }); }
    s.tiers = s.tiers.filter((t) => !removedTierIds.includes(t.id));
    tiers.forEach((t, i) => {
      const data = { name: t.name, price: +t.price, capacity: t.capacity ? +t.capacity : null, max_per_order: t.max_per_order ? +t.max_per_order : null, door_only: !!t.door_only, is_active: !!t.is_active, sort_order: i + 1 };
      const found = t.id && s.tiers.find((x) => x.id === t.id);
      if (found) Object.assign(found, data);
      else s.tiers.push({ id: uid(), event_id: id, ...data });
    });
    save(s);
    return id;
  }
  const c = await client();
  let id = ev.id;
  if (id) unwrap(await c.from('events').update(row).eq('id', id));
  else id = unwrap(await c.from('events').insert(row).select('id').single()).id;

  if (removedTierIds.length) {
    const { error } = await c.from('ticket_tiers').delete().in('id', removedTierIds);
    if (error) throw new Error(error.code === '23503' ? 'No puedes borrar un tramo con órdenes. Desactívalo.' : error.message);
  }
  for (const [i, t] of tiers.entries()) {
    const data = { event_id: id, name: t.name, price: +t.price, capacity: t.capacity ? +t.capacity : null, max_per_order: t.max_per_order ? +t.max_per_order : null, door_only: !!t.door_only, is_active: !!t.is_active, sort_order: i + 1 };
    if (t.id) unwrap(await c.from('ticket_tiers').update(data).eq('id', t.id));
    else unwrap(await c.from('ticket_tiers').insert(data));
  }
  return id;
}

export async function saveSettings(settings) {
  if (DEMO) {
    const s = load();
    s.settings = { ...s.settings, ...settings };
    save(s);
    return s.settings;
  }
  const c = await client();
  return unwrap(await c.from('settings').upsert({ id: 1, ...settings, updated_at: new Date().toISOString() }).select().single());
}

/** Sube una imagen y devuelve su URL pública */
export async function uploadImage(file) {
  if (DEMO) {
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  const c = await client();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${new Date().getFullYear()}/${uid()}.${ext}`;
  unwrap(await c.storage.from('event-media').upload(path, file, { cacheControl: '31536000', upsert: false }));
  return c.storage.from('event-media').getPublicUrl(path).data.publicUrl;
}

export function resetDemo() {
  if (DEMO) localStorage.removeItem(KEY);
}
