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
 *   --periodo   arma data/corte.json a partir de las respuestas.
 *
 * El token NUNCA va en el código ni en el repositorio: se lee de la variable
 * de entorno TABLERO_API_TOKEN.
 *
 * Contrato de parámetros confirmado contra producción el 5 de noviembre de
 * 2026. Si un endpoint devuelve 400, lo primero que hay que revisar es esto.
 */
import { mkdir, writeFile } from 'node:fs/promises';

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
  console.error('\nEl armado de data/corte.json todavía no está escrito: falta conocer la\n' +
    'forma real de cada respuesta. Corre primero:\n\n' +
    '    TABLERO_API_TOKEN=... node scripts/extraer-corte.mjs --dump --periodo 2026-10\n\n' +
    'y pasa el contenido de muestras/ para mapearlo sin inventar nombres de campo.\n');
  process.exit(2);
}
