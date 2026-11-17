// Entradas: dibuja el QR de cada entrada y arma el PDF que se le manda al cliente.
// Las librerías viven en js/vendor (no dependen de internet externo) y se cargan
// solo cuando hacen falta.
import { longDate } from './util.js';

const loaded = {};
function loadScript(src) {
  loaded[src] ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => { delete loaded[src]; rej(new Error('No se pudo cargar ' + src)); };
    document.head.appendChild(s);
  });
  return loaded[src];
}
const vendor = (file) => new URL(`./vendor/${file}`, import.meta.url).href;

/** Carga el generador de QR. Llamar una vez antes de usar qrSVG(). */
export const loadQR = () => loadScript(vendor('qrcode.js'));

function matrix(text) {
  const qr = window.qrcode(0, 'M'); // corrección media: aguanta pantallas rayadas
  qr.addData(text);
  qr.make();
  return { n: qr.getModuleCount(), dark: (r, c) => qr.isDark(r, c) };
}

/** Tramos horizontales de módulos oscuros: [fila, columna, largo] */
function runs({ n, dark }) {
  const out = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      let len = 1;
      while (c + len < n && dark(r, c + len)) len++;
      out.push([r, c, len]);
      c += len;
    }
  }
  return out;
}

/** QR como <svg> (fondo blanco con margen). Requiere loadQR() antes. */
export function qrSVG(text, label = 'Código QR de la entrada') {
  const m = matrix(text);
  const q = 3; // margen en módulos
  const size = m.n + q * 2;
  const d = runs(m).map(([r, c, len]) => `M${c + q} ${r + q}h${len}v1h-${len}z`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// ───────────────────────── PDF ─────────────────────────

let logoData;
async function logo() {
  if (logoData !== undefined) return logoData;
  try {
    const blob = await (await fetch(new URL('../assets/img/logo-funekes.jpg', import.meta.url))).blob();
    logoData = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  } catch { logoData = null; }
  return logoData;
}

// Las fuentes estándar del PDF solo traen Latin-1: se quita lo que no se puede dibujar (emojis, etc.)
const latin = (s) => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
const fileSafe = (s) => latin(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const W = 90, H = 178; // mm: formato vertical, se lee bien en el celular

function drawTicket(doc, { order, event, ticket, index, total, logoImg }) {
  const cx = W / 2;
  const text = (str, y, { size = 9, style = 'normal', color = [244, 239, 232], font = 'helvetica', space = 0, maxW = W - 16 } = {}) => {
    doc.setFont(font, style);
    doc.setFontSize(size);
    // achica el texto hasta que entre en una línea
    const width = () => doc.getTextWidth(str) + space * (str.length - 1);
    while (size > 6 && width() > maxW) doc.setFontSize((size -= 0.5));
    doc.setTextColor(...color);
    // centrado a mano: jsPDF no cuenta el espaciado entre letras al centrar
    doc.text(str, cx - width() / 2, y, { charSpace: space });
  };

  // fondo
  doc.setFillColor(0, 0, 0);
  doc.rect(0, 0, W, H, 'F');

  // logo
  if (logoImg) doc.addImage(logoImg, 'JPEG', cx - 17, 5, 34, 34);
  else text('FUNEKES', 26, { size: 24, style: 'bold' });

  // evento
  text('FUNEKES PRESENTA', 45, { size: 6.5, style: 'bold', color: [255, 74, 61], space: 0.9 });
  text(latin(event.title).toUpperCase(), 53.5, { size: 19, style: 'bold' });
  text(latin(longDate(event.starts_at)), 60, { size: 9.5, color: [200, 195, 188] });
  const place = [event.venue, event.location].map(latin).filter(Boolean).join(' · ');
  text(place, 65, { size: 7.5, color: [150, 145, 139] });

  // tarjeta blanca con el QR
  const card = 62, cardX = cx - card / 2, cardY = 71;
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(cardX, cardY, card, card + 9, 3, 3, 'F');
  const m = matrix(ticket.qr_code);
  const qrSize = card - 10;
  const cell = qrSize / m.n;
  const qx = cardX + 5, qy = cardY + 5;
  doc.setFillColor(0, 0, 0);
  // 0.02 mm de traslape para que no queden líneas blancas entre módulos
  for (const [r, c, len] of runs(m)) doc.rect(qx + c * cell, qy + r * cell, len * cell + 0.02, cell + 0.02, 'F');
  text(ticket.qr_code, cardY + card + 4.6, { size: 10.5, style: 'bold', font: 'courier', color: [0, 0, 0], space: 0.4 });

  // titular
  text('ENTRADA A NOMBRE DE', 151, { size: 6, style: 'bold', color: [150, 145, 139], space: 0.8 });
  text(latin(`${ticket.first_name} ${ticket.last_name}`), 158.5, { size: 16, style: 'bold' });
  const meta = [latin(order.tier_name), `Orden ${order.code}`, total > 1 ? `Entrada ${index + 1} de ${total}` : null].filter(Boolean).join('  ·  ');
  text(meta, 164, { size: 7.5, color: [200, 195, 188] });

  // condiciones
  doc.setDrawColor(70, 70, 70);
  doc.setLineWidth(0.2);
  doc.setLineDashPattern([0.8, 0.8], 0);
  doc.line(8, 167.5, W - 8, 167.5);
  doc.setLineDashPattern([], 0);
  text('Válida para 1 ingreso. Muestra este QR en la puerta y no lo compartas.', 171.5, { size: 5.8, color: [150, 145, 139] });
  text('Sin devolución. Traspaso solo por WhatsApp con Funekes.', 174.5, { size: 5.8, color: [150, 145, 139] });
}

/**
 * Descarga el PDF de una orden pagada: una página por entrada, cada una con su QR y su nombre.
 * Devuelve el nombre del archivo.
 */
export async function downloadTicketsPDF(order, event) {
  const [logoImg] = await Promise.all([logo(), loadQR(), loadScript(vendor('jspdf.umd.min.js'))]);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: 'portrait', compress: true });
  const tickets = order.tickets || [];
  tickets.forEach((ticket, index) => {
    if (index) doc.addPage([W, H], 'portrait');
    drawTicket(doc, { order, event, ticket, index, total: tickets.length, logoImg });
  });
  doc.setProperties({ title: `Entrada ${latin(event.title)} · ${order.code}`, author: 'Funekes' });
  const who = tickets.length === 1 ? `${tickets[0].first_name} ${tickets[0].last_name}` : order.buyer_name;
  const name = `Entrada-${fileSafe(event.title)}-${fileSafe(who)}-${order.code}.pdf`;
  doc.save(name);
  return name;
}
