/* ---------------------------------------------------------------------------
 * llamadas.mjs — un solo lugar donde vive el contrato con la API.
 * Lo usan la función de Vercel y el script de línea de comandos, para que no
 * puedan desincronizarse.
 * ------------------------------------------------------------------------- */

export const BASE_POR_DEFECTO = 'https://virtual.bpmsas.co/api/v1/metrics';
export const CABECERA = 'X-API-Token';
export const REGLA_ESPERADA = 'virtual-metrics-v1';

/** Los once llamados para un periodo YYYY-MM. */
export function llamadasDe(periodo) {
  const [anio, mes] = periodo.split('-').map(Number);
  if (!anio || !mes || mes < 1 || mes > 12) throw new Error(`periodo inválido: "${periodo}"`);

  const prev = new Date(Date.UTC(anio, mes - 2, 1));
  const aPrev = prev.getUTCFullYear(), mPrev = prev.getUTCMonth() + 1;

  /* 24 meses: hacen falta los doce anteriores para comparar contra el año pasado */
  const desdeSerie = new Date(Date.UTC(anio, mes - 24, 1)).toISOString().slice(0, 7);

  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const fDesde = `${periodo}-01`;
  const fHasta = `${periodo}-${String(ultimoDia).padStart(2, '0')}`;

  return [
    { nombre: 'certificaciones',      ruta: 'certificaciones', params: { year: anio,  month: mes  } },
    { nombre: 'certificaciones_prev', ruta: 'certificaciones', params: { year: aPrev, month: mPrev } },
    { nombre: 'empresas',             ruta: 'empresas',        params: { year: anio,  month: mes  } },
    { nombre: 'empresas_prev',        ruta: 'empresas',        params: { year: aPrev, month: mPrev } },
    { nombre: 'recompra',             ruta: 'recompra',        params: { year: anio,  month: mes  } },
    { nombre: 'serie',                ruta: 'serie',           params: { desde: desdeSerie, hasta: periodo } },
    { nombre: 'vencimientos',         ruta: 'vencimientos',    params: { dias: 30 } },
    { nombre: 'atribucion',           ruta: 'atribucion',      params: { desde: fDesde, hasta: fHasta } },
    { nombre: 'cursos',               ruta: 'cursos',          params: {} },
    { nombre: 'health',               ruta: 'health',          params: {} },
    { nombre: 'calidad-dato',         ruta: 'calidad-dato',    params: {} },
  ];
}

/** Una llamada, con el sobre validado. Lanza con un mensaje legible. */
export async function pedir({ base, token, ruta, params, timeoutMs = 90000 }) {
  const url = new URL(`${base}/${ruta}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { [CABECERA]: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`${ruta}: no respondió (${e.message})`);
  }

  const texto = await res.text();
  if (!res.ok) throw new Error(`${ruta}: HTTP ${res.status} · ${texto.slice(0, 200)}`);

  let json;
  try { json = JSON.parse(texto); }
  catch { throw new Error(`${ruta}: la respuesta no es JSON`); }

  if (json.ok !== true) throw new Error(`${ruta}: la respuesta trae ok=${JSON.stringify(json.ok)}`);
  if (json.regla && json.regla !== REGLA_ESPERADA) {
    throw new Error(`${ruta}: regla "${json.regla}", se esperaba "${REGLA_ESPERADA}"`);
  }
  return json;
}

/** Los once en paralelo. Devuelve { muestras, tiempos }. */
export async function traerTodo({ base, token, periodo }) {
  const lista = llamadasDe(periodo);
  const t0 = Date.now();
  const resultados = await Promise.all(lista.map(async (l) => {
    const t = Date.now();
    const json = await pedir({ base, token, ruta: l.ruta, params: l.params });
    return { nombre: l.nombre, json, ms: Date.now() - t, desde_cache: !!json.desde_cache };
  }));
  const muestras = {};
  const tiempos = {};
  for (const r of resultados) { muestras[r.nombre] = r.json; tiempos[r.nombre] = r.ms; }
  return { muestras, tiempos, total_ms: Date.now() - t0 };
}
