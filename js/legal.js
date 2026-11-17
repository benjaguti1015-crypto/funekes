// Páginas legales: completa los enlaces de contacto con los datos del panel.
import { getSettings } from './data.js';

getSettings().then((s) => {
  const wa = (s?.whatsapp || '').replace(/\D/g, '');
  const ig = (s?.instagram || '99funekes').replace(/^@/, '');
  document.querySelectorAll('[data-wa]').forEach((a) => {
    if (wa) a.href = `https://wa.me/${wa}`;
    else a.hidden = true;
  });
  document.querySelectorAll('[data-ig]').forEach((a) => {
    a.href = `https://instagram.com/${ig}`;
    if (a.dataset.ig === 'handle') a.textContent = `@${ig}`;
  });
}).catch(() => {});
