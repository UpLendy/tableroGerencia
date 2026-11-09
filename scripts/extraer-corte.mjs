/**
 * extraer-corte.mjs — habla con la capa de métricas de la plataforma.
 *
 *   TABLERO_API_TOKEN=... node scripts/extraer-corte.mjs --dump
 *   TABLERO_API_TOKEN=... node scripts/extraer-corte.mjs --periodo 2026-10
 *
 * Dos modos:
 *
 *   --dump      llama los nueve endpoints y guarda la respuesta cruda de cada
 *               uno en muestras/. No interpreta nada. Sirve para conocer la
 *               forma real de los datos antes de mapearlos.
 *
 *   --periodo   arma data/corte.json llamando a las tres plataformas y lo
 *               publica en data/. Si el archivo data/narrativa.json existe,
 *               incluye sus prioridades en el corte.
 *
 * El token NUNCA va en el código ni en el repositorio: se lee de la variable
 * de entorno TABLERO_API_TOKEN.
 *
 * Contrato de parámetros confirmado contra producción el 5 de noviembre de
 * 2026. Si un endpoint devuelve 400, lo primero que hay que revisar es esto.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const BASE = process.env.TABLERO_API_BASE || 'https://virtual.bpmsas.co/api/v1/metrics';
const TOKEN = process.env.TABLERO_API_TOKEN;
const CABECERA = 'X-API-Token';
const REGLA_ESPERADA = 'virtual-metrics-v1';

if (!TOKEN) {
  console.error('\nFalta TABLERO_API_TOKEN en el entorno.\n' +
    'No se pone en el código ni en el repositorio: se pasa al correr el script\n' +
    'o se guarda como secreto del repositorio en GitHub.\n');
  process.exit(2);
}

/* ------------------------------------------------------------------ args */
const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valor = (f, def) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : def; };

const periodo = valor('--periodo', new Date().toISOString().slice(0, 7)); // YYYY-MM
const [anio, mes] = periodo.split('-').map(Number);
if (!anio || !mes || mes < 1 || mes > 12) {
  console.error(`--periodo debe ser YYYY-MM; llegó "${periodo}"`);
  process.exit(2);
}

/* mes anterior, para la comparación del tablero */
const prevD = new Date(Date.UTC(anio, mes - 2, 1));
const periodoPrev = prevD.toISOString().slice(0, 7);

/* Ventana de la serie: 24 meses. Hacen falta los doce anteriores para poder
   comparar el mes contra el mismo mes del año pasado; con doce no alcanza. */
const desdeSerie = new Date(Date.UTC(anio, mes - 24, 1)).toISOString().slice(0, 7);

const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
const fDesde = `${periodo}-01`;
const fHasta = `${periodo}-${String(ultimoDia).padStart(2, '0')}`;

/**
 * Los nueve endpoints con sus parámetros reales.
 * OJO: no son los que decía la especificación original; aquellos daban 400.
 */
const LLAMADAS = [
  ['certificaciones',      { year: anio, month: mes }],
  ['certificaciones_prev', { year: prevD.getUTCFullYear(), month: prevD.getUTCMonth() + 1 },
                           'certificaciones'],
  ['empresas',             { year: anio, month: mes }],
  ['empresas_prev',        { year: prevD.getUTCFullYear(), month: prevD.getUTCMonth() + 1 },
                           'empresas'],
  ['recompra',             { year: anio, month: mes }],
  ['serie',                { desde: desdeSerie, hasta: periodo }],
  ['vencimientos',         { dias: 30 }],
  ['atribucion',           { desde: fDesde, hasta: fHasta }],
  ['cursos',               {}],
  ['calidad-dato',         {}],
];

/* ------------------------------------------------------------------ http */
async function pedir(ruta, params) {
  const url = new URL(`${BASE}/${ruta}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { [CABECERA]: TOKEN, Accept: 'application/json' },
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw new Error(`${ruta}: no respondió (${e.message})`);
  }
  const ms = Date.now() - t0;

  const texto = await res.text();
  if (!res.ok) {
    throw new Error(`${ruta}: HTTP ${res.status} · ${texto.slice(0, 300)}`);
  }

  let json;
  try { json = JSON.parse(texto); }
  catch { throw new Error(`${ruta}: la respuesta no es JSON · ${texto.slice(0, 200)}`); }

  /* El sobre es parte del contrato: si cambia, hay que enterarse, no adivinar. */
  if (json.ok !== true) {
    throw new Error(`${ruta}: la respuesta trae ok=${JSON.stringify(json.ok)}`);
  }
  if (json.regla && json.regla !== REGLA_ESPERADA) {
    throw new Error(`${ruta}: regla "${json.regla}", se esperaba "${REGLA_ESPERADA}". ` +
      'El motor cambió de criterio; no se puede mezclar con cifras anteriores.');
  }

  return { json, ms, url: url.toString() };
}

/* ------------------------------------------------------------------ dump */
async function volcar() {
  await mkdir('muestras', { recursive: true });
  const resumen = [];
  let fallos = 0;

  for (const [nombre, params, rutaReal] of LLAMADAS) {
    const ruta = rutaReal || nombre;
    process.stdout.write(`  ${nombre.padEnd(22)}`);
    try {
      const { json, ms } = await pedir(ruta, params);
      await writeFile(`muestras/${nombre}.json`, JSON.stringify(json, null, 2));
      const cache = json.desde_cache ? 'caché' : 'calculado';
      console.log(`ok   ${String(ms).padStart(6)} ms   ${cache}`);
      resumen.push({ nombre, ruta, params, ms, desde_cache: !!json.desde_cache, ok: true });
    } catch (e) {
      fallos++;
      console.log(`FALLA  ${e.message}`);
      resumen.push({ nombre, ruta, params, ok: false, error: e.message });
    }
  }

  await writeFile('muestras/_resumen.json', JSON.stringify({
    base: BASE, periodo, generado_en: new Date().toISOString(), llamadas: resumen,
  }, null, 2));

  console.log(`\nMuestras en muestras/ · ${LLAMADAS.length - fallos} de ${LLAMADAS.length} bien.`);
  console.log('El token NO queda en ningún archivo.\n');
  if (fallos) process.exit(1);
}

/* ------------------------------------------------------------------ main */
if (tiene('--dump')) {
  console.log(`\nVolcando respuestas crudas · periodo ${periodo} · base ${BASE}\n`);
  await volcar();
} else {
  await armarYGuardar();
}

/* ---------------------------------------------------------------- armar */
async function armarYGuardar() {
  /* Las importaciones van aquí dentro para que --dump no las necesite y siga
     funcionando aunque mapeo.mjs tenga un error de sintaxis. */
  const { traerTodasLasFuentes } = await import('./llamadas.mjs');
  const { armarCorte }           = await import('./mapeo.mjs');

  console.log(`\nArmar data/corte.json · periodo ${periodo}\n`);

  /* Narrativa opcional: las prioridades de la semana las escribe una persona
     en data/narrativa.json. Si no existe, el corte sale sin prioridades y el
     tablero lo avisa. No es un error; es el flujo normal. */
  let narrativa = {};
  try {
    const raw = await readFile(
      new URL('../data/narrativa.json', import.meta.url), 'utf8');
    narrativa = JSON.parse(raw);
    console.log('  narrativa.json encontrado · se incluyen las prioridades');
  } catch {
    console.log('  sin narrativa.json · el corte saldrá sin prioridades (normal)');
  }

  console.log('  consultando las tres plataformas…');
  const t0 = Date.now();
  const { muestras, tiempos, fallaron } = await traerTodasLasFuentes(periodo);

  /* Que Trámites o Alimentia no hayan respondido es tolerable, pero hay que
     decirlo con claridad para que quien revise el corte sepa qué faltó. */
  const nFallaron = Object.keys(fallaron).length;
  if (nFallaron) {
    console.warn(`\n  ⚠  ${nFallaron} fuente(s) no respondieron:\n`);
    for (const [k, msg] of Object.entries(fallaron)) {
      console.warn(`     ${k}: ${msg}`);
    }
    console.warn('');
  }

  console.log('  armando el corte…');
  const corte = armarCorte(muestras, narrativa, fallaron);
  corte.tiempos_ms = { ...tiempos, total: Date.now() - t0 };

  await mkdir(new URL('../data', import.meta.url), { recursive: true });
  const ruta = new URL('../data/corte.json', import.meta.url);
  await writeFile(ruta, JSON.stringify(corte, null, 2));

  const kb = (JSON.stringify(corte).length / 1024).toFixed(1);
  console.log(`\n✓ data/corte.json actualizado · corte ${corte.corte} · ${kb} KB\n`);
  if (nFallaron) {
    console.log('  El corte quedó guardado pero sin las fuentes indicadas arriba.\n');
  }
}
