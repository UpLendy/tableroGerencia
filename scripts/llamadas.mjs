/* ---------------------------------------------------------------------------
 * llamadas.mjs — un solo lugar donde vive el contrato con la API.
 * Lo usan la función de Vercel y el script de línea de comandos, para que no
 * puedan desincronizarse.
 * ------------------------------------------------------------------------- */

import { FUENTES, llamadasTramites, llamadasAlimentia } from './fuentes.mjs';

export const BASE_POR_DEFECTO = 'https://virtual.bpmsas.co/api/v1/metrics';
export const CABECERA = 'X-API-Token';
export const REGLA_ESPERADA = 'virtual-metrics-v1';

/** Los once llamados para un periodo YYYY-MM. */
export function llamadasDe(periodo) {
  const [anio, mes] = periodo.split('-').map(Number);
  if (!anio || !mes || mes < 1 || mes > 12) throw new Error(`periodo inválido: "${periodo}"`);

  const prev = new Date(Date.UTC(anio, mes - 2, 1));
  const aPrev = prev.getUTCFullYear(), mPrev = prev.getUTCMonth() + 1;

  /* Y el anterior a ese. Hace falta para el cruce contra Siigo: para saber si
     lo facturado en octubre corresponde al servicio de septiembre, hay que
     tener las certificaciones de septiembre por empresa. Con solo dos meses,
     el cruce de octubre no puede mirar hacia atras y las empresas facturadas
     por adelantado salen descuadradas sin estarlo. Es una llamada mas. */
  const prev2 = new Date(Date.UTC(anio, mes - 3, 1));
  const aPrev2 = prev2.getUTCFullYear(), mPrev2 = prev2.getUTCMonth() + 1;

  /* 24 meses: hacen falta los doce anteriores para comparar contra el año pasado */
  const desdeSerie = new Date(Date.UTC(anio, mes - 24, 1)).toISOString().slice(0, 7);

  /* Última cohorte con ventana cerrada: su mes tiene que haber terminado hace
     más de los días de gracia. Con 90 días y corte en noviembre, es julio. */
  const GRACIA_DIAS = 90;
  const cerrada = (() => {
    const hoy = new Date();
    for (let atras = 1; atras <= 36; atras++) {
      const d = new Date(Date.UTC(anio, mes - atras, 1));
      const finMes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      if (finMes.getTime() + GRACIA_DIAS * 864e5 <= hoy.getTime()) {
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
      }
    }
    return { year: anio, month: mes };
  })();

  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const fDesde = `${periodo}-01`;
  const fHasta = `${periodo}-${String(ultimoDia).padStart(2, '0')}`;

  return [
    { nombre: 'certificaciones',      ruta: 'certificaciones', params: { year: anio,  month: mes  } },
    { nombre: 'certificaciones_prev', ruta: 'certificaciones', params: { year: aPrev, month: mPrev } },
    { nombre: 'certificaciones_prev2',ruta: 'certificaciones', params: { year: aPrev2, month: mPrev2 } },
    { nombre: 'empresas',             ruta: 'empresas',        params: { year: anio,  month: mes  } },
    { nombre: 'empresas_prev',        ruta: 'empresas',        params: { year: aPrev, month: mPrev } },
    { nombre: 'recompra',             ruta: 'recompra',        params: { year: anio,  month: mes  } },
    /* La cohorte del mes en curso todavía está dentro de su ventana de gracia,
       así que su tasa no es un resultado sino una foto a mitad de camino. Se
       pide además la última cohorte cuya ventana ya cerró, que es la única
       cifra de renovación que se puede afirmar. */
    { nombre: 'recompra_cerrada',     ruta: 'recompra',        params: cerrada },
    { nombre: 'serie',                ruta: 'serie',           params: { desde: desdeSerie, hasta: periodo } },
    { nombre: 'vencimientos',         ruta: 'vencimientos',    params: { dias: 30 } },
    { nombre: 'atribucion',           ruta: 'atribucion',      params: { desde: fDesde, hasta: fHasta } },
    { nombre: 'cursos',               ruta: 'cursos',          params: {} },
    { nombre: 'calidad-dato',         ruta: 'calidad-dato',    params: {} },
  ];
}

/* Sin estos cinco no hay tablero. Los demas enriquecen, y si fallan el
   corte sale igual con esa parte declarada ausente. Importa porque la
   plataforma limita a 60 peticiones por minuto y por IP: toda la carga
   viene de una sola IP de Vercel, asi que conviene no depender de once. */
export const ESENCIALES = new Set([
  'certificaciones', 'certificaciones_prev', 'serie', 'vencimientos', 'calidad-dato',
]);

/* ------------------------------------------------------------- memoria
   La plataforma admite 60 peticiones por minuto y por IP, y todas salen de
   la misma IP de Vercel. Cada clic en el selector de mes dispara doce
   llamadas a formación, de modo que tres meses seguidos rozan el límite y
   el cuarto se lleva un 429 en mitad de una demostración.

   Buena parte de esas doce se repiten sin necesidad. Tres no dependen del
   mes —vencimientos, cursos, calidad-dato— y se volvían a pedir idénticas
   en cada clic. Y al pasar de noviembre a octubre, las certificaciones de
   octubre ya se habían traído un segundo antes como «mes anterior»: misma
   ruta, mismos parámetros, misma respuesta.

   Así que se guarda por ruta y parámetros, no por nombre: lo que decide si
   dos llamadas son la misma es lo que se le pide al servidor, no cómo lo
   llame el corte. Noventa segundos, que es más corto que el tiempo que se
   tarda en mirar un mes y menos de lo que tarda la plataforma en cambiar
   de dato.

   Se guarda la PROMESA, no el resultado: lo que ahoga a la plataforma son
   doce llamadas saliendo a la vez, y si se esperara a tener la respuesta
   para empezar a compartirla, las simultáneas saldrían todas igual. */
const MEMORIA = new Map();
const MEMORIA_MS = Number(process.env.CACHE_MS || 90000);
const MEMORIA_TOPE = 200;

const llave = (base, ruta, params) => {
  const p = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${base}|${ruta}|${p}`;
};

/** Vacía la memoria. Para las pruebas y para quien quiera forzar lectura. */
export function olvidar() { MEMORIA.clear(); }

/** Qué hay guardado ahora mismo. Solo para pruebas y diagnóstico. */
export function memoria() {
  return { entradas: MEMORIA.size, ms: MEMORIA_MS, llaves: [...MEMORIA.keys()] };
}

/** Una llamada, con el sobre validado. Lanza con un mensaje legible. */
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pedir({ base, token, ruta, params, timeoutMs = 90000, intentos = 2, reglaEsperada, sinMemoria = false }) {
  const k = llave(base, ruta, params);
  if (!sinMemoria) {
    const v = MEMORIA.get(k);
    if (v && Date.now() - v.t < MEMORIA_MS) return v.p;
    if (v) MEMORIA.delete(k);
  }

  const p = pedirConReintento({ base, token, ruta, params, timeoutMs, intentos, reglaEsperada });

  if (!sinMemoria) {
    /* Una respuesta que falló no se guarda: si no, un 429 pasajero dejaría
       esa ruta rota durante el minuto y medio siguiente. */
    p.catch(() => { if (MEMORIA.get(k)?.p === p) MEMORIA.delete(k); });
    if (MEMORIA.size >= MEMORIA_TOPE) MEMORIA.delete(MEMORIA.keys().next().value);
    MEMORIA.set(k, { t: Date.now(), p });
  }
  return p;
}

async function pedirConReintento({ base, token, ruta, params, timeoutMs, intentos, reglaEsperada }) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      return await pedirUnaVez({ base, token, ruta, params, timeoutMs, reglaEsperada });
    } catch (e) {
      ultimo = e;
      /* 429 es el limite por minuto de la plataforma. Esperar y repetir una
         vez resuelve el caso comun de varias cargas seguidas. */
      if (!/\b429\b/.test(String(e.message)) || i === intentos - 1) throw e;
      await dormir(1200 + i * 1800);
    }
  }
  throw ultimo;
}

async function pedirUnaVez({ base, token, ruta, params, timeoutMs, reglaEsperada }) {
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
  /* Cada plataforma tiene su propia regla. Si se pasa reglaEsperada, se
     valida; si no, se acepta cualquier regla (modo permisivo para endpoints
     que no informan versión). */
  if (reglaEsperada && json.regla && json.regla !== reglaEsperada) {
    throw new Error(`${ruta}: regla "${json.regla}", se esperaba "${reglaEsperada}"`);
  }
  return json;
}

/** Los once en paralelo. Devuelve { muestras, tiempos }. */
export async function traerTodo({ base, token, periodo, reglaEsperada = REGLA_ESPERADA }) {
  const lista = llamadasDe(periodo);
  const t0 = Date.now();

  const resultados = await Promise.allSettled(lista.map(async (l) => {
    const t = Date.now();
    const json = await pedir({ base, token, ruta: l.ruta, params: l.params, reglaEsperada });
    return { nombre: l.nombre, json, ms: Date.now() - t };
  }));

  const muestras = {}, tiempos = {}, fallaron = {};
  resultados.forEach((r, i) => {
    const nombre = lista[i].nombre;
    if (r.status === 'fulfilled') {
      muestras[nombre] = r.value.json;
      tiempos[nombre] = r.value.ms;
    } else {
      fallaron[nombre] = String(r.reason && r.reason.message || r.reason);
    }
  });

  /* Solo se cae si falta algo sin lo cual no hay tablero. Que no responda
     el catalogo de cursos no justifica dejar a nadie sin cifras. */
  const faltan = [...ESENCIALES].filter((n) => !muestras[n]);
  if (faltan.length) {
    throw new Error(faltan.map((n) => `${n}: ${fallaron[n] || 'sin respuesta'}`).join(' · '));
  }

  return { muestras, tiempos, fallaron, total_ms: Date.now() - t0 };
}


/**
 * Las tres plataformas. Formación es la única imprescindible: sin ella no hay
 * tablero. Trámites y Alimentia entran si responden, y si no, el corte sale
 * igual diciendo cuál faltó y por qué.
 */
export async function traerTodasLasFuentes(periodo) {
  const fallaron = {};
  const tiempos = {};
  const muestras = {};

  /* Formación: imprescindible. Si revienta, revienta el corte. */
  const base = await traerTodo({
    base: FUENTES.formacion.base,
    token: FUENTES.formacion.token(),
    periodo,
    reglaEsperada: FUENTES.formacion.regla,
  });
  Object.assign(muestras, base.muestras);
  Object.assign(tiempos, base.tiempos);
  Object.assign(fallaron, base.fallaron || {});

  /* Las otras dos, en paralelo y toleradas. */
  const extras = [
    ['tramites', FUENTES.tramites, llamadasTramites(periodo)],
    ['alimentia', FUENTES.alimentia, llamadasAlimentia(periodo)],
  ];

  await Promise.all(extras.map(async ([clave, fuente, lista]) => {
    const token = fuente.token();
    if (!token) {
      fallaron[clave] = 'no hay token configurado para esta plataforma';
      return;
    }
    const res = await Promise.allSettled(lista.map(async (l) => {
      const t = Date.now();
      const json = await pedir({ base: fuente.base, token, ruta: l.ruta, params: l.params, reglaEsperada: fuente.regla });
      return { nombre: l.nombre, json, ms: Date.now() - t };
    }));
    res.forEach((r, i) => {
      const nombre = lista[i].nombre;
      if (r.status === 'fulfilled') {
        muestras[nombre] = r.value.json;
        tiempos[nombre] = r.value.ms;
      } else {
        fallaron[nombre] = String((r.reason && r.reason.message) || r.reason);
      }
    });
  }));

  return { muestras, tiempos, fallaron };
}
