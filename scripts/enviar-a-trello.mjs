/* ---------------------------------------------------------------------------
 * enviar-a-trello.mjs — lleva las alertas del corte publicado a Trello.
 *
 * Corre una vez por corte, nunca por visita a la página: las alertas se
 * calculan en cada carga del tablero y empujar a Trello desde ahí sería
 * escribir en el tablero de la clienta cada vez que alguien abre el navegador.
 *
 *   node scripts/enviar-a-trello.mjs --listas <idTablero>   averigua los id
 *   node scripts/enviar-a-trello.mjs --ensayo               dice qué haría
 *   node scripts/enviar-a-trello.mjs                        lo hace
 * ------------------------------------------------------------------------- */
import { readFile } from 'node:fs/promises';
import { adjuntarCartera } from './alertas.mjs';
import { sincronizar, listasDe, CONFIG, elegibles } from './trello.mjs';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? (process.argv[i + 1] || true) : null; };

const leer = async (f) => {
  try { return JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url), 'utf8')); }
  catch { return null; }
};

const tablero = arg('--listas');
if (tablero) {
  if (tablero === true) { console.error('\n  falta el id del tablero: sale de su URL, trello.com/b/<ESTO>/nombre\n'); process.exit(1); }
  const ls = await listasDe(String(tablero));
  console.log(`\n  Listas de ese tablero:\n`);
  for (const l of ls) console.log(`    ${l.id}  ${l.nombre}`);
  console.log(`\n  Pon el id de la que quieras en TRELLO_LISTA.\n`);
  process.exit(0);
}

const corte = await leer('corte.json');
if (!corte) { console.error('\n  no hay data/corte.json\n'); process.exit(1); }
adjuntarCartera(corte, await leer('cartera.json'), await leer('conciliacion.json'));

const ensayo = process.argv.includes('--ensayo');
const todas = corte.alertas || [];
const opciones = { severidades: CONFIG.severidades(), incluirGerencia: CONFIG.incluirGerencia() };
const van = elegibles(todas, opciones);

console.log(`\nAlertas del corte del ${corte.corte}: ${todas.length}`);
console.log(`  severidades que van: ${opciones.severidades.join(', ')}`);
console.log(`  alertas de gerencia: ${opciones.incluirGerencia ? 'SÍ se envían' : 'no se envían'}`);
console.log(`  se enviarían: ${van.length}\n`);

const r = await sincronizar(todas, { ...opciones, corte: corte.corte, ensayo });
if (!r.ok) { console.error('  ' + r.error + '\n'); process.exit(1); }

const cuenta = {};
for (const p of r.plan) cuenta[p.accion] = (cuenta[p.accion] || 0) + 1;
console.log(ensayo ? '  ENSAYO · no se tocó nada. Esto es lo que haría:\n' : '  Hecho:\n');
for (const p of r.plan) console.log(`    ${p.accion.padEnd(16)} ${p.id}`);
console.log('\n  ' + Object.entries(cuenta).map(([k, v]) => `${k}: ${v}`).join(' · ') + '\n');
