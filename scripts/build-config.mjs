// Vercel: escribe js/config.js con las variables de entorno al publicar.
// Acepta los nombres más comunes (incluidos los que crea la integración Supabase ↔ Vercel).
import { writeFileSync } from 'node:fs';

const pick = (names) => {
  for (const n of names) {
    const v = (process.env[n] || '').trim();
    if (v) return [n, v];
  }
  return [null, ''];
};

const [urlName, url] = pick([
  'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL', 'PUBLIC_SUPABASE_URL',
]);
const [keyName, key] = pick([
  'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_KEY',
]);

const env = process.env.VERCEL_ENV || 'local';

if (!url || !key) {
  // Solo nombres, nunca valores.
  const seen = Object.keys(process.env).filter((k) => /supa/i.test(k)).sort();
  console.error(`✖ Entorno: ${env}. Falta ${!url ? 'la URL' : ''}${!url && !key ? ' y ' : ''}${!key ? 'la anon key' : ''} de Supabase.`);
  console.error(`  Variables con "supa" que ve el build: ${seen.length ? seen.join(', ') : '(ninguna)'}`);
  console.error('  Revisa en Vercel → Settings → Environment Variables que estén marcadas para el entorno de arriba y luego haz Redeploy.');
  if (env === 'production') process.exit(1);
  console.warn('  La web queda en modo demo.');
}

if (key && /^sb_secret_|service_role/i.test(key + keyName)) {
  console.error('✖ Esa key es SECRETA (service_role / sb_secret). Usa la anon o publishable key.');
  process.exit(1);
}

writeFileSync(
  new URL('../js/config.js', import.meta.url),
  `export const SUPABASE_URL = ${JSON.stringify(url)};\nexport const SUPABASE_ANON_KEY = ${JSON.stringify(key)};\n`
);
console.log(`✔ js/config.js generado [${env}] ${url ? `con ${urlName} + ${keyName}` : 'en modo demo'}`);
