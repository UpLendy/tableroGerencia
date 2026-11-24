/* ---------------------------------------------------------------------------
 * extraer-trello.mjs — lee los tableros de Trello y escribe data/trello.json
 *
 * Corre una vez por corte, no por visita a la página.
 *
 *   TRELLO_TABLEROS=gvFNfzLH,oqP8z4jK node scripts/extraer-trello.mjs
 * ------------------------------------------------------------------------- */
import { mkdir, writeFile } from 'node:fs/promises';
import { traerTablero, resumirTablero, armarTrello, CONFIG, DIAS_QUIETA } from './trello.mjs';

const nf = (n) => Number(n).toLocaleString('es-CO');
const t0 = Date.now();

const clave = CONFIG.clave(), token = CONFIG.token();
const ids = CONFIG.tableros();
if (!clave || !token) { console.error('\n  faltan TRELLO_CLAVE o TRELLO_TOKEN\n'); process.exit(1); }
if (!ids.length) { console.error('\n  falta TRELLO_TABLEROS (ids separados por coma)\n'); process.exit(1); }

console.log(`\nTrello · ${ids.length} tablero(s)\n`);

const resumenes = [];
for (const id of ids) {
  const crudo = await traerTablero(id, { clave, token });
  const r = resumirTablero(crudo);
  resumenes.push(r);
  console.log(`  ${r.nombre}`);
  console.log(`    ${nf(r.vivas)} pendientes · ${nf(r.vencidas)} vencidas · ${nf(r.sin_fecha)} sin fecha`);
  /* Lo excluido se dice siempre. Un informe que descarta 70 tarjetas en
     silencio es un informe en el que no se puede confiar. */
  for (const e of r.excluidas) console.log(`    excluida por ser historial: «${e.nombre}» (${nf(e.tarjetas)} tarjetas)`);
  if (r.tarjetas_sin_columna) console.log(`    ${nf(r.tarjetas_sin_columna)} tarjeta(s) en una columna que no se pudo leer`);
  for (const p of r.columnas_paradas) console.log(`    columna parada: «${p.columna}» · ${nf(p.tarjetas)} tarjetas, ${nf(p.dias)} días sin tocarse`);
  console.log('');
}

const t = armarTrello(resumenes);
t.tiempos_ms = { total: Date.now() - t0 };

/* Comprobaciones antes de publicar, no después. */
const fallos = [];
const sumaVivas = t.tableros.reduce((a, x) => a + x.vivas, 0);
const sumaColumnas = t.tableros.reduce((a, x) => a + x.columnas.reduce((b, c) => b + c.vivas, 0), 0);
if (sumaVivas !== sumaColumnas) fallos.push(`las columnas suman ${sumaColumnas} y los tableros dicen ${sumaVivas}`);
if (t.vencidas.length !== t.resumen.vencidas) fallos.push('la lista de vencidas no cuadra con el resumen');
const vencidasPorTablero = t.tableros.reduce((a, x) => a + x.vencidas, 0);
if (vencidasPorTablero !== t.vencidas.length) fallos.push(`los tableros cuentan ${vencidasPorTablero} vencidas y la lista trae ${t.vencidas.length}`);
if (t.vencidas.some((v) => !(v.dias >= 0))) fallos.push('hay una vencida con días negativos o sin número');
if (!t.tableros.length) fallos.push('no se leyó ningún tablero');

if (fallos.length) {
  console.error('✗ El resumen de Trello no cuadra consigo mismo. No se publica:\n');
  for (const f of fallos) console.error('   ' + f);
  console.error('');
  process.exit(1);
}

await mkdir(new URL('../data', import.meta.url), { recursive: true });
await writeFile(new URL('../data/trello.json', import.meta.url), JSON.stringify(t, null, 2));

console.log(`  TOTAL · ${nf(t.resumen.vivas)} pendientes en ${nf(t.resumen.tableros)} tableros`);
console.log(`          ${nf(t.resumen.vencidas)} vencidas · ${nf(t.resumen.columnas_paradas)} columnas paradas (+${DIAS_QUIETA}d)`);
console.log(`          ${nf(t.resumen.excluidas)} tarjetas de historial fuera de la cuenta`);
if (t.vencidas.length) {
  console.log(`\n  LAS CINCO MÁS ATRASADAS:`);
  for (const v of t.vencidas.slice(0, 5)) {
    console.log(`    ${String(v.dias).padStart(4)}d  ${String(v.columna).slice(0, 28).padEnd(30)} ${String(v.nombre).slice(0, 44)}`);
  }
}
console.log(`\n✓ data/trello.json · ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
