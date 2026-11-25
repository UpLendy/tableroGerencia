/* ---------------------------------------------------------------------------
 * extraer-cencosud.mjs — lee Firestore y escribe data/cencosud.json
 *
 * Corre una vez al día, no por visita a la página: son unas cincuenta
 * peticiones y cuarenta segundos, y lo que informa —cuánta gente se certificó
 * en un mes— no cambia de una hora a otra.
 *
 *   CENCOSUD_CUENTA="$(cat service_account.json)" node scripts/extraer-cencosud.mjs
 *
 * Admite --desde y --hasta en YYYY-MM para recalcular una ventana distinta.
 * ------------------------------------------------------------------------- */
import { mkdir, writeFile } from 'node:fs/promises';
import { armarCencosud, faltaConfiguracion, PERMANENCIA_SEG } from './cencosud.mjs';

const nf = (n) => Number(n).toLocaleString('es-CO');
const t0 = Date.now();

const arg = (nombre) => {
  const i = process.argv.indexOf(nombre);
  return i > 0 ? process.argv[i + 1] : null;
};

const faltan = faltaConfiguracion();
if (faltan.length) {
  console.error(`\n  falta en el entorno: ${faltan.join(', ')}\n`);
  process.exit(1);
}

const hoy = new Date();
const hasta = arg('--hasta') || hoy.toISOString().slice(0, 7);
/* Veinticuatro meses, los mismos que la serie del tablero. La plataforma
   empezó en junio de 2025, así que hoy la ventana la cubre entera; cuando
   deje de cubrirla, el tablero seguirá mostrando dos años como las demás
   fuentes y no habrá que cambiar nada. */
const desde = arg('--desde') ||
  new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 23, 1)).toISOString().slice(0, 7);

if (!/^\d{4}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}$/.test(hasta) || desde > hasta) {
  console.error(`\n  ventana inválida: ${desde} .. ${hasta}\n`);
  process.exit(1);
}

console.log(`\nCencosud · ${desde} .. ${hasta}\n`);

const c = await armarCencosud({ desde, hasta });

if (c.ausente) {
  console.error(`\n✗ ${c.ausente}\n`);
  process.exit(1);
}

/* ------------------------------------------------- comprobaciones, antes de
   publicar y no después. Las mismas que en cartera y Trello: un archivo que
   no cuadra consigo mismo no se publica, porque en la pantalla de gerencia
   una cifra baja no se distingue de una cifra correcta. */
const fallos = [];
const avisos = [];
const meses = c.total.meses;

if (!meses.length) fallos.push('no quedó ni un mes con certificaciones');

const suma = meses.reduce((a, m) => a + c.por_mes[m].certificaciones, 0);
if (suma !== c.total.certificaciones) {
  fallos.push(`los meses suman ${suma} certificaciones y el total dice ${c.total.certificaciones}`);
}

for (const m of meses) {
  const x = c.por_mes[m];
  if (m < desde || m > hasta) fallos.push(`el mes ${m} se salió de la ventana`);
  if (x.personas > x.certificaciones) {
    fallos.push(`${m}: ${x.personas} personas con ${x.certificaciones} certificaciones`);
  }
  if (x.permanencia_medida > x.certificaciones) {
    fallos.push(`${m}: se midió permanencia a ${x.permanencia_medida} de ${x.certificaciones}`);
  }
  if (x.cumplen_permanencia > x.permanencia_medida) {
    fallos.push(`${m}: cumplen ${x.cumplen_permanencia} de ${x.permanencia_medida} medidas`);
  }
  if (x.permanencia_medida + x.permanencia_sin_umbral !== x.certificaciones) {
    fallos.push(`${m}: medidas + sin umbral no dan las certificaciones del mes`);
  }
  const sp = x.por_programa.reduce((a, p) => a + p.certificaciones, 0);
  if (sp !== x.certificaciones) fallos.push(`${m}: los programas suman ${sp} y el mes dice ${x.certificaciones}`);
}

/* Una persona no puede aparecer en más meses que certificaciones tiene. */
if (c.total.personas > c.total.certificaciones) {
  fallos.push(`${c.total.personas} personas distintas con ${c.total.certificaciones} certificaciones`);
}

/* El factor de copia no revienta nada, pero si cambia hay que mirarlo: toda
   la deduplicación se apoya en que cada documento está escrito dos veces. */
if (c.copias_por_documento !== 2) {
  avisos.push(`el factor de copia es ${c.copias_por_documento} y no 2; conviene revisar la deduplicación`);
}

const sinUmbral = meses.reduce((a, m) => a + c.por_mes[m].permanencia_sin_umbral, 0);
if (sinUmbral) {
  const progs = new Set();
  for (const m of meses) {
    for (const p of c.por_mes[m].por_programa) if (p.cumplen_permanencia === null) progs.add(p.nombre);
  }
  avisos.push(`${nf(sinUmbral)} certificaciones sin umbral de permanencia: ${[...progs].join(', ')}`);
}

if (fallos.length) {
  console.error('✗ El resumen de Cencosud no cuadra consigo mismo. No se publica:\n');
  for (const f of fallos) console.error('   ' + f);
  console.error('');
  process.exit(1);
}

await mkdir(new URL('../data', import.meta.url), { recursive: true });
await writeFile(new URL('../data/cencosud.json', import.meta.url), JSON.stringify(c, null, 2));

/* ------------------------------------------------------------------ informe */
console.log('mes        certif.  personas   >=360 min');
for (const m of meses) {
  const x = c.por_mes[m];
  const perm = x.permanencia_medida ? `${nf(x.cumplen_permanencia)}/${nf(x.permanencia_medida)}` : '-';
  console.log(`${m}  ${String(nf(x.certificaciones)).padStart(8)}  ${String(nf(x.personas)).padStart(8)}  ${perm.padStart(11)}`);
}

const medidas = meses.reduce((a, m) => a + c.por_mes[m].permanencia_medida, 0);
const cumplen = meses.reduce((a, m) => a + c.por_mes[m].cumplen_permanencia, 0);

console.log(`\n  TOTAL · ${nf(c.total.certificaciones)} certificaciones · ${nf(c.total.personas)} personas distintas`);
console.log(`          permanencia: ${nf(cumplen)} de ${nf(medidas)} medidas (${medidas ? (100 * cumplen / medidas).toFixed(1) : 0} %)`);
console.log(`          umbral de alimentos: ${PERMANENCIA_SEG / 60} min · avances totales: ${nf(c.avances_totales)}`);
console.log(`          copias por documento: ${c.copias_por_documento}`);

for (const a of avisos) console.log(`\n  aviso: ${a}`);

console.log(`\n✓ data/cencosud.json · ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
