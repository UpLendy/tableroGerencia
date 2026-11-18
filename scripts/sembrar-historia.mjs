/* ---------------------------------------------------------------------------
 * sembrar-historia.mjs — la historia de certificaciones por empresa.
 *
 *     TABLERO_API_TOKEN=... node scripts/sembrar-historia.mjs --meses 8
 *
 * Escribe data/historia-empresas.json. SOLO LECTURA contra la plataforma.
 *
 * El saldo acumulado por cliente necesita saber cuanto certifico cada empresa
 * cada mes, hacia atras. El corte solo transporta tres meses, y pedirle doce
 * en cada corrida serian doce llamadas mas cada noche a una plataforma que ya
 * se bloquea a ratos.
 *
 * Por eso la historia es un REGISTRO que se siembra una vez y despues se
 * mantiene con lo que cada corte ya trae. Mismo patron que los meses
 * cerrados, que lleva cuatro cortes funcionando.
 *
 * Correrlo otra vez no pisa lo que ya hay salvo que se pida --rehacer: un mes
 * ya registrado es un dato de cierre, y la plataforma lo mueve.
 * ------------------------------------------------------------------------- */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pedir, BASE_POR_DEFECTO, REGLA_ESPERADA } from './llamadas.mjs';

const args = process.argv.slice(2);
const valor = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MESES = Math.max(1, Math.min(24, Number(valor('--meses', 8)) || 8));
const REHACER = args.includes('--rehacer');

if (!process.env.TABLERO_API_TOKEN) {
  console.error('\nFalta TABLERO_API_TOKEN.\n' +
    '  TABLERO_API_TOKEN=$(node ~/respaldo_bpm/diag/token-estado.mjs --solo-token) \\\n' +
    '    node scripts/sembrar-historia.mjs --meses 8\n');
  process.exit(2);
}

const ARCHIVO = new URL('../data/historia-empresas.json', import.meta.url);
const nf = (n) => Number(n).toLocaleString('es-CO');

let reg = { version: 1, meses: {} };
try {
  reg = JSON.parse(await readFile(ARCHIVO, 'utf8'));
  console.log(`\n  registro existente: ${Object.keys(reg.meses).length} mes(es)`);
} catch { console.log('\n  sin registro previo · se crea'); }

const hoy = new Date();
const pedidos = [];
for (let i = 1; i <= MESES; i++) {
  const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 1));
  pedidos.push({ periodo: d.toISOString().slice(0, 7),
                 year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
}

console.log(`  pidiendo ${pedidos.length} mes(es): ${pedidos.map((x) => x.periodo).join(', ')}\n`);

let nuevos = 0, saltados = 0;
for (const { periodo, year, month } of pedidos) {
  if (reg.meses[periodo] && !REHACER) {
    console.log(`  ${periodo}  ya estaba · se respeta`);
    saltados++;
    continue;
  }
  try {
    const r = await pedir({
      base: process.env.TABLERO_API_BASE || BASE_POR_DEFECTO,
      token: process.env.TABLERO_API_TOKEN,
      ruta: 'certificaciones',
      params: { year, month },
      reglaEsperada: REGLA_ESPERADA,
    });
    const filas = (r?.datos?.por_empresa || [])
      .filter((x) => x.codigo && x.codigo !== '(particular)')
      .map((x) => [String(x.codigo), Number(x.certificados || 0)]);
    reg.meses[periodo] = {
      por_empresa: Object.fromEntries(filas),
      total: Number(r?.datos?.total_certificados || 0),
      leido_en: new Date().toISOString(),
    };
    nuevos++;
    console.log(`  ${periodo}  ${String(nf(filas.length)).padStart(4)} empresas · ` +
                `${nf(r?.datos?.total_certificados || 0)} certificaciones`);
  } catch (e) {
    console.error(`  ${periodo}  falló: ${String(e.message).slice(0, 90)}`);
  }
}

reg.actualizado_en = new Date().toISOString();
await mkdir(new URL('../data', import.meta.url), { recursive: true });
await writeFile(ARCHIVO, JSON.stringify(reg, null, 2));

console.log('');
console.log(`  ✓ data/historia-empresas.json · ${Object.keys(reg.meses).length} mes(es) en total` +
            ` (${nuevos} nuevo(s), ${saltados} respetado(s))`);
console.log('');
