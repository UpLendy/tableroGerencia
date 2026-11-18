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
import { cartera, facturadoPorMes, comprasPorTercero, conciliar } from './conciliacion.mjs';
import { readFile } from 'node:fs/promises';

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

/* ------------------------------------------------------- la conciliación
   El cruce vive aquí y no en el corte porque las facturas ya están en
   memoria: sale sin una sola llamada más a Siigo. Lo único que necesita del
   otro lado son las empresas con su NIT, que lee del corte publicado.

   Se calcula sobre el ÚLTIMO MES CERRADO, no sobre el mes en curso. La
   facturación va detrás de la certificación, así que cruzar un mes a medias
   daría un descuadre que no existe: el mismo error de comparar un periodo
   incompleto contra uno completo que la Dirección ya nos señaló una vez.

   Si el corte no está o no tiene meses cerrados, no se escribe nada y se
   dice. Un cruce a medias es peor que ninguno: alguien lo leería. */
try {
  let corte = null;
  try { corte = JSON.parse(await readFile(new URL('../data/corte.json', import.meta.url), 'utf8')); }
  catch { throw new Error('no hay data/corte.json todavía'); }

  const cerrados = (corte.meses || []).filter((m) => m.cerrado).map((m) => m.id).sort();
  const periodo = cerrados[cerrados.length - 1];
  if (!periodo) throw new Error('el corte no tiene ningún mes cerrado');

  /* Las certificaciones del mes cerrado salen del corte, que para un mes
     cerrado ya trae la cifra congelada y no la que la plataforma reporte
     hoy. Cruzar contra la de hoy sería cruzar contra un número que ya se
     movió. */
  const empresas = (corte.empresas || [])
    .map((e) => ({ codigo: e.codigo, nombre: e.nombre, nit: e.nit,
                   certificados: Number((e.meses || {})[periodo] || 0) }))
    .filter((e) => e.certificados > 0);
  if (!empresas.length) throw new Error('ninguna empresa certificó en ' + periodo);

  /* Si NINGUNA empresa trae documento, el problema no son los datos de BPM:
     es que este corte se generó antes de que el corte transportara el NIT, o
     antes de que la plataforma lo expusiera. Publicar el cruce así levantaría
     una alerta diciendo que decenas de empresas quedan fuera por su
     documento, que es falso y manda a alguien a corregir lo que no está mal.
     Se para y se dice qué hacer. */
  const conNit = empresas.filter((e) => String(e.nit || '').trim()).length;
  if (conNit === 0) {
    throw new Error(
      'el corte publicado no trae el NIT de ninguna empresa.\n' +
      '     Vuelve a generar el corte y repite:\n' +
      '       Actions → "Corte automático" → Run workflow,  o  npm run corte\n' +
      '     Si después de eso sigue en cero, revisa que el MetricsService.php\n' +
      '     desplegado exponga el campo nit en /api/v1/metrics/certificaciones.');
  }
  if (conNit < empresas.length / 2) {
    console.warn('');
    console.warn('  ⚠  solo ' + conNit + ' de ' + empresas.length + ' empresas traen NIT.');
    console.warn('     El cruce sale igual, pero con esa mitad fuera.');
  }

  /* Solo las facturas de ese mes: la ventana de la cartera son dos años. */
  const delMes = vigentes.filter((f) => String(f.date || '').slice(0, 7) === periodo);
  /* Y las del mes siguiente, para ver los clientes facturados a mes vencido:
     a ellos el servicio de octubre les llega en una factura de noviembre, y
     cruzar solo por fecha de factura los declara descuadrados sin estarlo. */
  const [a, m] = periodo.split('-').map(Number);
  const siguiente = new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 7);
  const delSiguiente = vigentes.filter((f) => String(f.date || '').slice(0, 7) === siguiente);
  const conc = conciliar(empresas, comprasPorTercero(delMes), terceros,
                         comprasPorTercero(delSiguiente));
  conc.periodo_siguiente = siguiente;
  conc.facturas_del_siguiente = delSiguiente.length;
  conc.periodo = periodo;
  conc.generado_en = new Date().toISOString();
  conc.facturas_del_periodo = delMes.length;
  conc.fuente = 'api.siigo.com · facturas de venta, cruzadas contra el corte';
  conc.nota_periodo =
    'Se cruza el último mes cerrado, no el mes en curso: la facturación va ' +
    'detrás de la certificación y un mes a medias daría un descuadre falso.';

  /* Comprobaciones antes de publicar. Un cruce que no cuadra consigo mismo
     haría que alguien llamara a un cliente a reclamarle algo que no debe. */
  const malos = [];
  const r = conc.resumen;
  /* Todos los estados posibles tienen que estar en esta suma. Si se agrega
     uno nuevo y se olvida aqui, esta comprobacion lo caza y no se publica,
     que es justo lo que paso al añadir via_consumidor_final. */
  const suma = r.cuadran + r.difieren + r.no_comparables + r.certifican_sin_facturar +
               r.sin_factura_en_el_periodo + r.sin_nit + r.nit_no_resuelto +
               (r.via_consumidor_final || 0);
  if (suma !== r.total) malos.push(`los estados suman ${suma} y hay ${r.total} empresas`);
  if (conc.empresas.some((e) => e.estado === 'cuadra' && e.diferencia !== 0))
    malos.push('hay una empresa marcada como que cuadra con diferencia distinta de cero');
  if (conc.empresas.some((e) => e.estado === 'no_comparable_por_paquetes' && e.diferencia !== null))
    malos.push('hay un no comparable con diferencia calculada, que no se puede saber');
  if (malos.length) {
    console.error('\n✗ La conciliación no cuadra consigo misma. No se publica:\n');
    for (const f of malos) console.error('   ' + f);
    console.error('');
    process.exit(1);
  }

  await writeFile(new URL('../data/conciliacion.json', import.meta.url), JSON.stringify(conc, null, 2));
  console.log('');
  console.log('  conciliación ' + periodo + ' · ' + r.total + ' empresas');
  console.log('      cuadran                  ' + r.cuadran);
  console.log('      difieren                 ' + r.difieren);
  console.log('      no comparables (paquete) ' + r.no_comparables);
  console.log('      certifican sin facturar  ' + r.certifican_sin_facturar);
  console.log('      sin factura en el mes    ' + r.sin_factura_en_el_periodo);
  console.log('      sin NIT / no resuelto    ' + r.sin_nit + ' / ' + r.nit_no_resuelto);
  console.log('      solo en Siigo            ' + r.solo_en_siigo);
  if (r.posible_desfase) {
    console.log('      de las que difieren, ' + r.posible_desfase +
      ' parecen facturadas a mes vencido');
  }
} catch (e) {
  console.log('');
  console.log('  sin conciliación: ' + e.message);
  console.log('  (la cartera sí quedó publicada)');
}

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
