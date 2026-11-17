// Control de puerta: el guardia escanea el QR de cada entrada.
// Solo valida entradas: esta pantalla nunca muestra ventas, precios ni la lista de compradores.
import { DEMO, getEvents, getDoorSession, signInDoor, signOut, checkIn, doorCount } from './data.js';
import { dateTime, esc, isPast, shortDate } from './util.js';
import QrScanner from './vendor/qr-scanner.min.js';

const $ = (s, el = document) => el.querySelector(s);

const st = {
  eventId: null,
  scanner: null,
  busy: false,   // validando contra el servidor
  showing: false, // hay un resultado en pantalla
  count: null,
};

// ───────────────────────── SESIÓN ─────────────────────────

async function boot() {
  const session = await getDoorSession().catch(() => null);
  if (session && !session.notStaff) return startApp();
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
    await signInDoor(f.email.value.trim(), f.password.value);
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

$('[data-logout]').addEventListener('click', async () => {
  st.scanner?.stop();
  await signOut();
  location.reload();
});

// ───────────────────────── EVENTO ─────────────────────────

async function startApp() {
  $('[data-login]').hidden = true;
  $('[data-app]').hidden = false;
  const sel = $('[data-event]');
  try {
    const events = await getEvents();
    // primero los que vienen (el más cercano arriba), después los pasados
    const upcoming = events.filter((e) => !isPast(e));
    const past = events.filter(isPast).reverse();
    const list = [...upcoming, ...past];
    st.eventId = list[0]?.id ?? null;
    sel.innerHTML = list.map((e) => `<option value="${e.id}">${esc(e.title)} · ${esc(shortDate(e.starts_at))}</option>`).join('');
    sel.disabled = list.length < 2;
  } catch {
    sel.innerHTML = '<option>Sin conexión</option>';
  }
  refreshCount();
  startCamera();
}

$('[data-event]').addEventListener('change', (e) => { st.eventId = e.target.value; refreshCount(); });

async function refreshCount() {
  if (!st.eventId) return;
  try {
    st.count = await doorCount(st.eventId);
    $('[data-count]').textContent = st.count;
  } catch { /* se actualiza en el próximo escaneo */ }
}

// ───────────────────────── CÁMARA ─────────────────────────

const cam = $('[data-cam]');

async function startCamera() {
  const text = $('[data-cam-text]');
  cam.dataset.state = 'starting';
  text.textContent = 'Abriendo la cámara…';
  try {
    st.scanner ||= new QrScanner($('[data-video]'), (r) => onCode(r.data), {
      preferredCamera: 'environment',
      maxScansPerSecond: 10,
      returnDetailedScanResult: true,
      highlightScanRegion: false,
      highlightCodeOutline: false,
    });
    await st.scanner.start();
    cam.dataset.state = 'on';
    // pantalla siempre encendida mientras se escanea
    navigator.wakeLock?.request('screen').catch(() => {});
    const flash = $('[data-flash]');
    flash.hidden = !(await st.scanner.hasFlash().catch(() => false));
  } catch (ex) {
    cam.dataset.state = 'error';
    const denied = /denied|notallowed|permission/i.test(String(ex?.name || ex));
    text.textContent = denied
      ? 'El navegador bloqueó la cámara. Dale permiso en los ajustes del sitio y vuelve a intentar. Mientras tanto puedes escribir el código abajo.'
      : 'No se pudo abrir la cámara. Revisa que no la esté usando otra app. Mientras tanto puedes escribir el código abajo.';
  }
}
$('[data-cam-start]').addEventListener('click', startCamera);

$('[data-flash]').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  try {
    await st.scanner.toggleFlash();
    b.setAttribute('aria-pressed', String(st.scanner.isFlashOn()));
  } catch { /* sin linterna */ }
});

// al volver a la pestaña la cámara puede haberse detenido
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st.scanner && cam.dataset.state === 'on') {
    st.scanner.start().catch(() => (cam.dataset.state = 'error'));
    navigator.wakeLock?.request('screen').catch(() => {});
  }
});

// ───────────────────────── VALIDACIÓN ─────────────────────────

const RESULTS = {
  ok:          { kind: 'ok',   icon: 'check', title: 'Adelante' },
  used:        { kind: 'bad',  icon: 'x',     title: 'Ya ingresó' },
  unpaid:      { kind: 'bad',  icon: 'x',     title: 'No está pagada' },
  cancelled:   { kind: 'bad',  icon: 'x',     title: 'Orden cancelada' },
  wrong_event: { kind: 'bad',  icon: 'x',     title: 'Es de otro evento' },
  not_found:   { kind: 'bad',  icon: 'x',     title: 'QR no válido' },
  error:       { kind: 'warn', icon: 'x',     title: 'Sin conexión' },
};

async function onCode(code) {
  if (st.busy || st.showing || !code) return;
  st.busy = true;
  $('[data-hint]').textContent = 'Validando…';
  let r;
  try {
    r = await checkIn(code, st.eventId);
  } catch (ex) {
    r = { result: 'error', message: ex.message };
  }
  st.busy = false;
  $('[data-hint]').textContent = 'Apunta al código QR de la entrada.';
  show(r);
}

function show(r) {
  const def = RESULTS[r.result] || RESULTS.error;
  const sub = {
    ok: r.tier_name || '',
    used: r.checked_in_at ? `Esta entrada ya se escaneó el ${dateTime(r.checked_in_at)}. No dejar pasar.` : 'Esta entrada ya se usó. No dejar pasar.',
    unpaid: 'La orden sigue pendiente de pago. Que hable con la organización.',
    cancelled: 'Esta orden fue cancelada. No dejar pasar.',
    wrong_event: `La entrada es para ${r.event_title || 'otro evento'}.`,
    not_found: 'Este código no corresponde a ninguna entrada de Funekes.',
    error: `No se pudo validar${r.message ? `: ${r.message}` : ''}. Revisa la señal y vuelve a escanear.`,
  }[r.result] ?? '';

  const box = $('[data-res]');
  box.dataset.kind = def.kind;
  $('[data-res-icon]').innerHTML = `<svg aria-hidden="true"><use href="#i-${def.icon}"/></svg>`;
  $('[data-res-title]').textContent = def.title;
  $('[data-res-name]').textContent = r.name || '';
  $('[data-res-sub]').textContent = sub;
  st.showing = true;
  box.hidden = false;
  $('[data-res-next]').focus();

  if (r.result === 'ok') {
    if (st.count != null) $('[data-count]').textContent = ++st.count;
    else refreshCount();
  }
  feedback(def.kind === 'ok');
}

function closeResult() {
  $('[data-res]').hidden = true;
  $('[data-manual]').reset();
  // pequeña pausa para no releer el mismo QR que sigue frente a la cámara
  setTimeout(() => (st.showing = false), 500);
}
$('[data-res-next]').addEventListener('click', closeResult);

// vibración + tono corto: se entiende el resultado sin mirar la pantalla
let audio;
function feedback(ok) {
  navigator.vibrate?.(ok ? 80 : [140, 70, 140]);
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = ok ? 'sine' : 'square';
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.12, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (ok ? 0.18 : 0.4));
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.18 : 0.4));
  } catch { /* sin sonido */ }
}

// ───────────────────────── CÓDIGO A MANO ─────────────────────────

$('[data-manual]').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.currentTarget.code;
  const clean = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 12) {
    input.setAttribute('aria-invalid', 'true');
    $('[data-hint]').textContent = 'El código tiene 12 letras y números.';
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  input.blur();
  onCode(clean);
});

boot();
