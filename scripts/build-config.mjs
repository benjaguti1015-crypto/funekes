// Vercel: escribe js/config.js con las variables de entorno al publicar.
import { writeFileSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!url || !key) {
  const msg = 'Faltan SUPABASE_URL y/o SUPABASE_ANON_KEY en Vercel → Settings → Environment Variables.';
  if (process.env.VERCEL_ENV === 'production') {
    console.error(`✖ ${msg}`);
    process.exit(1);
  }
  console.warn(`⚠ ${msg} La web queda en modo demo.`);
}

writeFileSync(
  new URL('../js/config.js', import.meta.url),
  `export const SUPABASE_URL = ${JSON.stringify(url)};\nexport const SUPABASE_ANON_KEY = ${JSON.stringify(key)};\n`
);
console.log(`✔ js/config.js generado (${url ? 'Supabase' : 'modo demo'})`);
