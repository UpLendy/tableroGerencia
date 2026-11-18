/* ---------------------------------------------------------------------------
 * traer-corte-de-vercel.mjs — el corte, armado en Vercel, guardado aquí.
 *
 *     CRON_SECRET='...' node scripts/traer-de-vercel.mjs [2026-11]
 *
 * Vercel alcanza la plataforma y tiene los tres tokens; nosotros tenemos
 * `git push`. Esto junta las dos mitades: pide el corte armado, lo guarda en
 * ~/tablero-bpm/data y deja el commit listo para que lo revises y lo subas.
 *
 * No commitea ni empuja nada por su cuenta.
 * ------------------------------------------------------------------------- */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.TABLERO_URL || 'https://tablero-gerencial-chi.vercel.app';
const SECRETO = process.env.CRON_SECRET;
const periodo = process.argv[2] || new Date().toISOString().slice(0, 7);
/* La raiz del repositorio, que es donde van los archivos: este script vive
   dentro de el, asi que no hay que adivinarla ni pasarla por parametro. */
const TABLERO = new URL('..', import.meta.url).pathname;

if (!SECRETO) {
  console.error('\nFalta CRON_SECRET (el mismo que pusiste en Vercel):');
  console.error("   CRON_SECRET='...' node traer-corte-de-vercel.mjs\n");
  process.exit(2);
}

const url = `${BASE}/api/publicar?devolver=1&periodo=${periodo}`;
console.log('\n  pidiendo  ' + url + '\n');

const r = await fetch(url, { headers: { Authorization: 'Bearer ' + SECRETO },
                             signal: AbortSignal.timeout(120000) });
const d = await r.json().catch(() => ({}));

if (!r.ok || !d.ok) {
  console.error('  HTTP ' + r.status + ' · ' + (d.mensaje || d.error || 'sin detalle'));
  if (d.fugas) console.error('  fugas: ' + JSON.stringify(d.fugas));
  console.error('');
  process.exit(1);
}

for (const l of (d.resumen || [])) console.log('  ' + l);
if ((d.sin_respuesta || []).length) {
  console.log('\n  ⚠  fuentes sin respuesta: ' + d.sin_respuesta.join(', '));
  console.log('     Publicar así cambiaría el corte actual por uno sin esas secciones.');
}

if (!d.archivos) { console.error('\n  la respuesta no trajo archivos\n'); process.exit(1); }
for (const [ruta, contenido] of Object.entries(d.archivos)) {
  await writeFile(join(TABLERO, ruta), contenido);
  console.log('  escrito  ' + ruta);
}

console.log('');
console.log('  Revisa y publica:');
console.log('');
console.log('     npm run probar && node scripts/validar-corte.mjs');
console.log('     git add data/corte.json data/meses-cerrados.json');
console.log('     git commit -m "Corte ' + (d.corte || periodo) + '"');
console.log('     git pull --rebase origin main && git push origin main');
console.log('');
