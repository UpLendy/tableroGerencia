/**
 * extraer-cartera.mjs — la cartera por cobrar, leída de Siigo.
 *
 *     node scripts/extraer-cartera.mjs            últimos 24 meses
 *     node scripts/extraer-cartera.mjs --meses 36
 *
 * Escribe data/cartera.json. SOLO LECTURA contra Siigo.
 *
 * Va aparte del corte a propósito, por dos razones.
 *
 * La primera es que no necesita la plataforma de formación: la cartera sale
 * entera de Siigo. Así puede correr aunque formación esté bloqueada, que es
 * justo lo que lleva pasando desde ayer. Un proceso que depende de dos
 * fuentes se cae con cualquiera de las dos.
 *
 * La segunda es que si dos procesos escribieran data/corte.json se pisarían
 * al empujar al repositorio. Archivos distintos, procesos distintos.
 *
 * La ventana es de dos años porque una factura sin cobrar puede ser vieja, y
 * una cartera que solo mire el mes en curso no es una cartera.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { crearCliente, faltaConfiguracion } from './siigo.mjs';
import { cartera, facturadoPorMes } from './conciliacion.mjs';

const args = process.argv.slice(2);
const valor = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MESES = Math.max(1, Math.min(60, Number(valor('--meses', 24)) || 24));

const faltan = faltaConfiguracion();
if (faltan.length) {
  console.error('\nFaltan variables de entorno de Siigo: ' + faltan.join(', ') + '\n' +
    'No van en el código ni en el repositorio: se pasan al correr el script o\n' +
    'se guardan como secretos del repositorio en GitHub.\n');
  process.exit(2);
}

const hoy = new Date();
const hasta = hoy.toISOString().slice(0, 10);
const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - MESES, 1))
  .toISOString().slice(0, 10);

console.log(`\nCartera desde Siigo · ${desde} a ${hasta}\n`);

const t0 = Date.now();
const cli = await crearCliente();
console.log('  autenticado · el token dura ' + (cli.duracionToken / 3600).toFixed(0) + ' h');

console.log('  trayendo facturas…');
const { todas, vigentes } = await cli.facturas(desde, hasta);
console.log(`  ${todas.length} facturas · ${todas.length - vigentes.length} anuladas, que no cuentan`);

console.log('  trayendo el maestro de terceros…');
const terceros = await cli.terceros();
console.log(`  ${terceros.size} terceros`);

const c = cartera(vigentes, terceros, hasta);
c.generado_en = new Date().toISOString();
c.ventana = { desde, hasta, meses: MESES };
c.facturas_revisadas = vigentes.length;
c.fuente = 'api.siigo.com · facturas de venta';
/* Lo facturado mes a mes sale gratis: ya estan todas las facturas en
   memoria. Es lo que llena la tarjeta de ingreso del tablero, que llevaba
   desde el primer dia diciendo "pendiente del cruce con Siigo". */
c.facturado_por_mes = facturadoPorMes(vigentes);
c.nota_facturado =
  'Incluye todo lo que BPM factura: certificaciones, tramites INVIMA, ' +
  'asesorias presenciales y apto medico. No es comparable con el valor a ' +
  'precio de lista del tablero, que solo cuenta certificaciones.';
c.tiempos_ms = { total: Date.now() - t0 };

/* Comprobaciones antes de publicar, no después. Una cartera que no cuadra
   consigo misma es peor que no tenerla: alguien va a llamar a cobrar con
   ella. */
const fallos = [];
const sumaTramos = Object.values(c.por_antiguedad).reduce((a, x) => a + x, 0);
if (Math.round(sumaTramos) !== Math.round(c.total)) {
  fallos.push(`el total dice ${c.total} y los tramos de antigüedad suman ${sumaTramos}`);
}
if (c.total < 0) fallos.push('la cartera da negativa');
if (c.mayores.some((m) => m.saldo <= 0)) fallos.push('hay un tercero con saldo cero o negativo en la lista');
if (c.terceros > 0 && !c.total) fallos.push('hay terceros con saldo pero el total es cero');

if (fallos.length) {
  console.error('\n✗ La cartera no cuadra consigo misma. No se publica:\n');
  for (const f of fallos) console.error('   ' + f);
  console.error('');
  process.exit(1);
}

await mkdir(new URL('../data', import.meta.url), { recursive: true });
await writeFile(new URL('../data/cartera.json', import.meta.url), JSON.stringify(c, null, 2));

const cop = (n) => '$' + Math.round(n).toLocaleString('es-CO');
console.log('');
const mesActual = hasta.slice(0, 7);
const fm = c.facturado_por_mes[mesActual];
if (fm) {
  console.log('  facturado ' + mesActual + ' : ' + cop(fm.facturado) +
    ' · cobrado ' + cop(fm.cobrado) + ' · pendiente ' + cop(fm.saldo));
}
console.log('  por cobrar      : ' + cop(c.total) + ' · ' + c.terceros + ' terceros');
for (const [k, v] of Object.entries(c.por_antiguedad)) {
  if (v) console.log('      ' + k.padEnd(12) + cop(v));
}
console.log('');
console.log('  los cinco mayores:');
for (const m of c.mayores.slice(0, 5)) {
  console.log('      ' + String(m.nombre || m.nit).slice(0, 40).padEnd(42) +
    String(cop(m.saldo)).padStart(14) +
    (m.mas_vieja_dias !== null ? '   la más vieja de ' + m.mas_vieja_dias + ' días' : ''));
}
console.log('');
console.log(`✓ data/cartera.json · ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
