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

  /* ------------------------------------------------- meses ya cerrados
     Un mes cerrado no debería moverse, y en esta plataforma se mueve: renovar
     un curso reutiliza el registro del certificado anterior y le sobre-escribe
     cert_date, así que el certificado se muda de mes. Octubre de 2025 marcaba
     1.518 por la mañana y 1.512 por la tarde del mismo día.

     Por eso la cifra se congela cuando el mes cierra y no se vuelve a tocar:
     data/meses-cerrados.json es el único sitio donde queda la cifra original,
     porque la plataforma ya no la tiene. Si empieza a reportar otra, se dice
     en voz alta en vez de recalcularla en silencio.

     OJO con el orden: el registro se lee ANTES de escribir el corte nuevo. La
     primera versión de esto leía data/corte.json después de sobrescribirlo y
     comparaba el corte contra sí mismo, así que no detectaba nada nunca. */
  const congelado = await import('./congelado.mjs');
  const rutaRegistro = new URL(congelado.ARCHIVO, import.meta.url);

  let registro = congelado.registroVacio();
  try {
    registro = JSON.parse(await readFile(rutaRegistro, 'utf8'));
    console.log(`  meses cerrados en el registro: ${Object.keys(registro.meses || {}).length}`);
  } catch {
    console.log('  sin registro de meses cerrados · se crea en este corte');
  }

  console.log('  armando el corte…');

  /* Se arma dos veces a propósito: una para poder comparar contra lo cerrado
     y otra con la deriva dentro, porque las alertas se calculan en armarCorte
     y tienen que verla. Armar es cálculo sobre datos ya traídos; no cuesta
     una segunda llamada a nadie. */
  const preliminar = armarCorte(muestras, narrativa, fallaron);
  const laDeriva = congelado.deriva(registro, preliminar);

  const corte = armarCorte(muestras, narrativa, fallaron, {
        cerrados: registro,
        ...(laDeriva.length ? {
        deriva_meses_cerrados: { desde: preliminar.corte, cambios: laDeriva },
        /* Se conserva el nombre anterior para no romper a quien ya lo lee. */
        meses_cerrados_que_cambiaron: {
          desde: preliminar.corte,
          cambios: laDeriva.map((x) => ({
            periodo: x.periodo, campo: x.campo,
            antes: x.cerrado, despues: x.ahora, diferencia: x.diferencia,
          })),
        },
        } : {}),
      });

  corte.tiempos_ms = { ...tiempos, total: Date.now() - t0 };

  if (laDeriva.length) {
    const r = congelado.resumirDeriva(laDeriva);
    console.log(`\n⚠ ${r.meses} mes(es) ya cerrado(s) cambiaron en la plataforma:\n`);
    for (const x of laDeriva) {
      console.log(`   ${x.periodo} · ${x.campo}: cerrado en ${x.cerrado} → hoy ${x.ahora} ` +
                  `(${x.diferencia > 0 ? '+' : ''}${x.diferencia})` +
                  (x.cerrado_en ? `   [cerrado el ${x.cerrado_en}]` : ''));
    }
    console.log('\n  El tablero muestra la cifra cerrada; la diferencia sale como alerta.\n');
  }

  /* Congelar va después de comparar: un mes que se cierra en este mismo corte
     no puede aparecer como deriva de sí mismo. */
  const { registro: actualizado, nuevos } = congelado.congelar(registro, corte);
  if (nuevos.length) {
    console.log('  se cierran ' + nuevos.length + ' mes(es): ' +
      nuevos.map((x) => `${x.periodo}=${x.cert}`).join(', '));
  }
  corte.meses_cerrados_registrados = Object.keys(actualizado.meses || {}).length;

  await mkdir(new URL('../data', import.meta.url), { recursive: true });
  await writeFile(new URL('../data/corte.json', import.meta.url),
                  JSON.stringify(corte, null, 2));
  await writeFile(rutaRegistro, JSON.stringify(actualizado, null, 2));

  /* La vista de Equipo no se publica como segundo archivo: la despoja
     /api/publicado en cada petición. Un solo archivo publicado es un sitio
     menos donde dos versiones del mismo corte puedan discrepar. Lo que sí se
     hace aquí es comprobarlo antes de subir, no después. */
  const { despojarParaEquipo, fugasDeEquipo } = await import('./vista.mjs');
  const fugas = fugasDeEquipo(despojarParaEquipo(corte));
  if (fugas.length) {
    console.error('\n✗ La vista de Equipo dejaría escapar datos que no debe:\n');
    for (const f of fugas) console.error(`   ${f.ruta} · ${f.motivo}`);
    console.error('\nNo se publica nada hasta corregirlo.\n');
    process.exit(1);
  }

  const kb = (JSON.stringify(corte).length / 1024).toFixed(1);
  console.log(`\n✓ data/corte.json actualizado · corte ${corte.corte} · ${kb} KB`);
  console.log(`✓ vista de Equipo comprobada: sin dinero ni cifras por persona\n`);
  if (nFallaron) {
    console.log('  El corte quedó guardado pero sin las fuentes indicadas arriba.\n');
  }
}
