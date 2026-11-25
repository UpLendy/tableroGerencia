/* ---------------------------------------------------------------------------
 * cencosud.mjs — la quinta fuente del tablero: la plataforma de Cencosud.
 *
 * Esta plataforma no tiene API de métricas como las otras tres, así que el
 * tablero lee Firestore directamente, y solo a consultar.
 *
 * SOLO LECTURA, y por construcción, igual que siigo.mjs y trello.mjs:
 * comprobarRuta() solo admite runQuery y runAggregationQuery, y ninguna de
 * las dos puede escribir en Firestore. Escribir por REST es PATCH, POST a
 * :commit o DELETE, y ninguna de esas tres se nombra en este archivo.
 *
 * Toda consulta lleva select con los campos nombrados. De una persona viaja
 * su id opaco y nada más: ni nombre, ni correo, ni cédula entran al tablero.
 *
 * ---------------------------------------------------------------------------
 * CINCO COSAS QUE COSTARON AVERIGUAR Y QUE NO SE DEDUCEN DEL CÓDIGO
 *
 * 1. NO SON COLECCIONES RAÍZ, SON SUBCOLECCIONES. Los avances y los
 *    certificados viven en rutas como
 *      users/{u}/certification-enrollments/{e}/certificates/{id}
 *    así que una consulta a la colección «certification-enrollments» de la
 *    raíz devuelve cero documentos sin dar error. Hay que consultar el grupo
 *    de colecciones: allDescendants: true. La primera versión de este módulo
 *    no lo hacía y daba cero certificaciones con la base llena.
 *
 * 2. CADA DOCUMENTO ESTÁ GUARDADO DOS VECES. El framework lo escribe en dos
 *    rutas, una bajo el usuario y otra bajo la certificación. Un conteo del
 *    grupo de colecciones da el doble. Se deduplica por el id del documento,
 *    que es el mismo en las dos copias.
 *
 * 3. LOS CERTIFICADOS NO SIRVEN PARA CONTAR, aunque parezca lo natural. El
 *    PDF solo se genera cuando alguien lo descarga, no cuando la persona
 *    termina; cada regeneración crea un documento nuevo y marca el anterior
 *    como expired —hay una persona con ocho del mismo curso—; y el 13 de
 *    octubre se regeneró un grupo entero y se borraron catorce creados por
 *    error. Su expeditionDate no es la fecha en que nadie se certificó.
 *    Lo que se cuenta es el certification-enrollment completado.
 *
 * 4. DE LOS CUATRO CAMPOS QUE PARECEN DECIR «TERMINÓ», TRES ENGAÑAN:
 *      · courseEnrollment.status se queda en 'active' incluso en aprobados.
 *      · courseEnrollment.finalDate es opcional y está vacío. Y no es
 *        course.finalDate, que sí existe y es el cierre del grupo.
 *      · courseEnrollment.calification.status solo se recalcula cuando
 *        alguien genera un informe: hay una persona aprobada con 96,7 % cuya
 *        calification seguía en failed y 0 %.
 *    El bueno es certificationEnrollment.status === 'completed' con su
 *    finalizationDate, que la escribe el servidor en el momento real en que
 *    se aprueba el último requisito.
 *
 * 5. NO HAY ÍNDICES DE GRUPO, Y NO HACEN FALTA. Filtrar por status u ordenar
 *    por finalizationDate en un grupo de colecciones devuelve un 400 pidiendo
 *    un índice que esta base no tiene. Crearlo sería modificar la
 *    configuración de la base de producción de un cliente, y no hace falta:
 *    se trae el grupo entero ordenado por __name__, que está indexado
 *    siempre, y se filtra aquí. Son 24.240 documentos, unos 25.000 leídos al
 *    día, céntimos. Si esta plataforma llegara a cientos de miles, habría
 *    que volver a los índices; hasta entonces, no se toca nada del cliente.
 *
 * 6. time ESTÁ EN SEGUNDOS. El cronómetro del front cuenta de uno en uno y
 *    guarda cada sesenta, y solo cuenta mientras hay actividad: a los diez
 *    segundos sin mover el ratón se para. Así que es tiempo dedicado y no
 *    tiempo de reloj. Los 360 minutos que pide el informe de Cencosud son
 *    21.600 de estos.
 * ------------------------------------------------------------------------- */

import { createSign } from 'node:crypto';

export const REGLA = 'cencosud-firestore-v2';

const BASE = 'https://firestore.googleapis.com/v1';
const ALCANCE = 'https://www.googleapis.com/auth/datastore';

/* Las dos únicas rutas que este módulo sabe nombrar. */
const RUTAS = new Set(['runQuery', 'runAggregationQuery']);

/** La guardia de solo lectura, aparte para poder probarla sin red. */
export function comprobarRuta(ruta) {
  if (!RUTAS.has(ruta)) {
    throw new Error(`ruta no permitida: "${ruta}". Este modulo solo consulta.`);
  }
  return ruta;
}

/* -------------------------------------------------- la permanencia

   El informe de Cencosud no se contenta con que la persona complete el
   programa: exige ademas 360 minutos de dedicacion. Alguien puede salir
   «completado» en la plataforma y «revisar permanencia» en el informe.

   Esos 360 minutos son el umbral de MANIPULACION DE ALIMENTOS, que viene de
   la normativa. No son el de medicamentos OTC, y aplicarselo da una cifra
   falsa y alarmante: en junio de 2026 el OTC fueron 738 certificaciones y
   con este umbral solo unas 33 «cumplian», un 4 %, mientras el resto de los
   meses va entre el 92 y el 97 %.

   La plataforma NO sabe cual es el umbral de cada programa. Se mird: el
   campo `duration` trae 10 para carnicos y 10 para el OTC —el mismo numero
   para dos cursos de duracion distinta— y no existe en el programa
   principal. Asi que el umbral no se puede deducir de los datos.

   De modo que no se inventa. Los programas con umbral acordado lo tienen
   aqui; el OTC queda en null y el tablero dice que de ese programa no se
   mide la permanencia, en vez de decir que casi nadie la cumple. Cuando BPM
   diga cual es el del OTC, se escribe aqui y ya.

   Los ids son de Firestore y son estables; el nombre va al lado porque los
   nombres si cambian. Mismo criterio que no-son-empresa.mjs. */

/** El umbral de manipulacion de alimentos, en segundos. time va en segundos. */
export const PERMANENCIA_SEG = 360 * 60;

export const UMBRAL_POR_PROGRAMA = {
  /* MANIPULACION DE ALIMENTOS CARNICOS CENCOSUD — Decreto 1500 */
  '02a000f5-a1d8-4d8a-a709-138c4bfb7c0e': PERMANENCIA_SEG,
  /* MANIPULACION DE ALIMENTOS CENCOSUD (basicos) — Resolucion 2674 */
  '396c29a7-0934-40ba-b883-f1b40d5f7730': PERMANENCIA_SEG,
  /* PROGRAMA DE MANEJO Y COMERCIALIZACION DE MEDICAMENTOS OTC — pendiente */
  '07e4d94b-14d2-4e6a-8b83-f3b18d5f7740': null,
};

/**
 * El umbral de un programa, o null si no se mide.
 *
 * Un programa que no este en la tabla tambien devuelve null, a proposito: si
 * manana aparece un cuarto programa, lo que debe pasar es que su permanencia
 * no se mida hasta que alguien decida el umbral, no que herede el de
 * alimentos por descuido.
 */
export function umbralDe(programa) {
  const u = UMBRAL_POR_PROGRAMA[programa];
  return Number.isFinite(u) ? u : null;
}

const TIEMPO_MAX_MS = 60000;
const PAGINA = 500;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function faltaConfiguracion() {
  return process.env.CENCOSUD_CUENTA ? [] : ['CENCOSUD_CUENTA'];
}

/** La cuenta de servicio, desde el entorno. Admite JSON crudo o en base64,
 *  porque los secretos de GitHub con saltos de línea dan problemas. */
function leerCuenta() {
  const bruto = process.env.CENCOSUD_CUENTA || '';
  if (!bruto) throw new Error('falta CENCOSUD_CUENTA');
  let texto = bruto.trim();
  if (!texto.startsWith('{')) {
    try { texto = Buffer.from(texto, 'base64').toString('utf8'); }
    catch { throw new Error('CENCOSUD_CUENTA no es JSON ni base64'); }
  }
  let sa;
  try { sa = JSON.parse(texto); }
  catch { throw new Error('CENCOSUD_CUENTA no se pudo interpretar como JSON'); }
  for (const campo of ['client_email', 'private_key', 'project_id']) {
    if (!sa[campo]) throw new Error(`CENCOSUD_CUENTA sin ${campo}`);
  }
  return sa;
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function firmarJwt(sa) {
  const ahora = Math.floor(Date.now() / 1000);
  const sinFirma = [
    b64url({ alg: 'RS256', typ: 'JWT' }),
    b64url({
      iss: sa.client_email,
      scope: ALCANCE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: ahora,
      exp: ahora + 3600,
    }),
  ].join('.');
  const firma = createSign('RSA-SHA256').update(sinFirma).sign(sa.private_key).toString('base64url');
  return `${sinFirma}.${firma}`;
}

/* El token de Google dura una hora. Se reutiliza con cinco minutos de
   margen, igual que el de Siigo. */
let guardado = null;

async function tokenDeAcceso(sa) {
  if (guardado && guardado.correo === sa.client_email && Date.now() < guardado.vence) {
    return guardado.token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: firmarJwt(sa),
    }),
    signal: AbortSignal.timeout(TIEMPO_MAX_MS),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`autenticación con Google: HTTP ${res.status} · ${texto.slice(0, 160)}`);
  let json;
  try { json = JSON.parse(texto); }
  catch { throw new Error('autenticación con Google: la respuesta no es JSON'); }
  if (!json.access_token) throw new Error('autenticación con Google: sin access_token');
  guardado = {
    correo: sa.client_email,
    token: json.access_token,
    vence: Date.now() + Math.max(60, (Number(json.expires_in) || 3600) - 300) * 1000,
  };
  return guardado.token;
}

/** Olvida el token. Para las pruebas. */
export function olvidar() { guardado = null; }

async function pedir(cli, ruta, cuerpo, intentos = 3) {
  comprobarRuta(ruta);
  const url = `${BASE}/projects/${cli.proyecto}/databases/(default)/documents:${ruta}`;
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    let res, texto;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await tokenDeAcceso(cli.sa)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(TIEMPO_MAX_MS),
      });
      texto = await res.text();
    } catch (e) {
      ultimo = new Error(`${ruta}: no respondió (${e.message})`);
      await dormir(1500 * (i + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      ultimo = new Error(`${ruta}: HTTP ${res.status} · ${texto.slice(0, 200)}`);
      await dormir(1500 * (i + 1));
      continue;
    }
    if (!res.ok) {
      /* Un 400 de Firestore por falta de índice trae el enlace para crearlo.
         Vale la pena que salga entero. */
      throw new Error(`${ruta}: HTTP ${res.status} · ${texto.slice(0, 700)}`);
    }
    try { return JSON.parse(texto); }
    catch { throw new Error(`${ruta}: la respuesta no es JSON`); }
  }
  throw ultimo;
}

export async function crearCliente() {
  const sa = leerCuenta();
  const proyecto = process.env.CENCOSUD_PROYECTO || sa.project_id;
  return { sa, proyecto, correo: sa.client_email };
}

/* ------------------------------------------------------------------ valores */

const valor = (v) => {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  /* Los mapas hay que abrirlos. Pedir un campo anidado en select no devuelve
     la clave «a.b»: devuelve el mapa «a» entero. Sin esto, pedir
     testConfiguration.minimunCalificationToPass leia null en los 122 cursos
     y parecia que ninguno tenia nota minima configurada. No era un dato, era
     este agujero. */
  if ('mapValue' in v) {
    const m = {};
    for (const [k, w] of Object.entries((v.mapValue && v.mapValue.fields) || {})) m[k] = valor(w);
    return m;
  }
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(valor);
  return null;
};

/** Un campo que puede venir anidado: 'a.b.c' sobre lo que devolvio valor(). */
export const dentro = (obj, ruta) =>
  String(ruta).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

/** El mes YYYY-MM de un valor de fecha, sea marca de tiempo o texto. */
export function mesDe(v) {
  const s = valor(v);
  if (typeof s !== 'string' || s.length < 7) return null;
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/* Casi todo en esta base es subcolección, así que el grupo de colecciones es
   lo normal y la raíz la excepción (courses, companies, certifications). */
const desde_ = (coleccion, grupo = true) => [{ collectionId: coleccion, allDescendants: grupo }];

/** Cómo está guardado un campo de fecha: 'timestampValue', 'stringValue' o
 *  null si no hay ni un documento con ese campo. Decide el filtro. */
export async function olfatear(cli, coleccion, campo, grupo = true, mirar = 50) {
  /* Sin where. Un filtro sobre un campo de subcoleccion exige un indice de
     grupo que esta base no tiene, asi que se miran los primeros documentos y
     se busca el primero que traiga el campo. Para saber de que tipo es, da
     igual cual sea. */
  const json = await pedir(cli, 'runQuery', {
    structuredQuery: {
      from: desde_(coleccion, grupo),
      select: { fields: [{ fieldPath: campo }] },
      limit: mirar,
    },
  });
  for (const f of json || []) {
    const v = f.document && f.document.fields && f.document.fields[campo];
    if (v) return { tipo: Object.keys(v)[0], ejemplo: valor(v) };
  }
  return { tipo: null, ejemplo: null };
}

/** Cuántos documentos tiene una colección, sin leer ninguno. Para el censo. */
export async function contarColeccion(cli, coleccion, grupo = true) {
  const json = await pedir(cli, 'runAggregationQuery', {
    structuredAggregationQuery: {
      structuredQuery: { from: desde_(coleccion, grupo) },
      aggregations: [{ alias: 'n', count: {} }],
    },
  });
  const c = (json || []).map((f) => f.result && f.result.aggregateFields).find(Boolean);
  return c && c.n ? Number(c.n.integerValue || 0) : 0;
}

/**
 * Unos pocos documentos, para ver qué campos traen de verdad. `campos` es
 * obligatorio a propósito: aquí hay colecciones con cédulas y correos, y una
 * sonda no tiene por qué poder sacarlas sin que alguien escriba el nombre.
 */
export async function muestra(cli, coleccion, campos, limite = 3, grupo = true) {
  if (!Array.isArray(campos) || !campos.length) {
    throw new Error('muestra() necesita la lista de campos a pedir');
  }
  const json = await pedir(cli, 'runQuery', {
    structuredQuery: {
      from: desde_(coleccion, grupo),
      select: { fields: campos.map((c) => ({ fieldPath: c })) },
      limit: limite,
    },
  });
  return (json || []).filter((f) => f.document).map((f) => {
    const fila = { ruta: f.document.name, id: String(f.document.name || '').split('/').pop() };
    for (const [k, v] of Object.entries(f.document.fields || {})) {
      fila[k] = { tipo: Object.keys(v)[0], valor: valor(v) };
    }
    return fila;
  });
}

/* --------------------------------------------------------- la ventana

   NO se filtra en Firestore, y es a proposito. Filtrar por status u ordenar
   por finalizationDate en un grupo de colecciones exige un indice de grupo
   que este proyecto no tiene, y crearlo seria modificar la configuracion de
   la base de produccion de un cliente para algo que de todos modos se puede
   hacer sin tocar nada.

   La alternativa es traer el grupo entero ordenado por __name__ —que esta
   indexado siempre— y filtrar aqui. Son 24.240 documentos, unos 25.000
   leidos al dia: centimos. Si algun dia esta plataforma creciera a cientos
   de miles, conviene volver a los indices; hasta entonces, no. */

const mesSiguiente = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 7);
};

/**
 * De todo lo que se trajo, lo que cuenta: completado y dentro de la ventana.
 *
 * El estado se compara en minusculas y sin espacios porque es texto libre
 * en la base, no un enumerado que nadie valide.
 */
export function filtrarCompletadas(brutas, { desde, hasta }) {
  const tope = mesSiguiente(hasta);
  return brutas.filter((f) => {
    if (String(f.estado || '').trim().toLowerCase() !== 'completed') return false;
    if (!f.mes) return false;
    return f.mes >= desde && f.mes < tope;
  });
}

/**
 * Todos los avances de certificacion, paginados por __name__, con SOLO los
 * campos que hacen falta: el estado, la fecha, el programa, el curso, el
 * tiempo dedicado y el id opaco de la persona. Ni un nombre, ni un correo,
 * ni una cedula.
 *
 * Trae el grupo entero y filtra despues (ver arriba el porque). Devuelve las
 * filas crudas; deduplicar() y filtrarCompletadas() hacen el resto.
 */
export async function traerAvances(cli, { limite = 400000 } = {}) {
  const brutas = [];
  let cursor = null;

  for (let pagina = 0; pagina < 4000; pagina++) {
    const q = {
      from: desde_('certification-enrollments'),
      select: {
        fields: ['status', 'finalizationDate', 'certificationId', 'courseId', 'userId', 'time']
          .map((c) => ({ fieldPath: c })),
      },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: PAGINA,
    };
    if (cursor) q.startAt = { values: [{ referenceValue: cursor }], before: false };

    const json = await pedir(cli, 'runQuery', { structuredQuery: q });
    const docs = (json || []).map((f) => f.document).filter(Boolean);
    if (!docs.length) break;

    for (const d of docs) {
      const f = d.fields || {};
      brutas.push({
        id: String(d.name || '').split('/').pop(),
        estado: valor(f.status),
        mes: mesDe(f.finalizationDate),
        programa: valor(f.certificationId),
        curso: valor(f.courseId),
        persona: valor(f.userId),
        segundos: Number(valor(f.time)) || 0,
      });
    }
    if (brutas.length >= limite) break;
    if (docs.length < PAGINA) break;
    cursor = docs[docs.length - 1].name;
  }

  return brutas;
}

/**
 * Cada avance está escrito en dos rutas de Firestore con el MISMO id de
 * documento, una bajo el usuario y otra bajo la certificación. Sin esto
 * todas las cifras del tablero saldrían al doble, y al doble exacto, que es
 * lo que lo hace difícil de ver: un mes con 120 certificaciones reales dice
 * 240 y no hay nada obviamente roto en la pantalla.
 *
 * `copias` sale en el JSON a propósito. Si algún día el framework deja de
 * duplicar, o empieza a escribir una tercera copia, ese número lo dice sin
 * que nadie tenga que sospecharlo.
 */
export function deduplicar(brutas) {
  const vistas = new Map();
  for (const f of brutas) if (f && f.id && !vistas.has(f.id)) vistas.set(f.id, f);
  const filas = [...vistas.values()];
  return {
    filas,
    brutas: brutas.length,
    copias: filas.length ? Number((brutas.length / filas.length).toFixed(2)) : 0,
  };
}

/** El catálogo de programas, para poder nombrarlos. Es de tres. */
export async function traerProgramas(cli) {
  const json = await pedir(cli, 'runQuery', {
    structuredQuery: {
      from: desde_('certifications', false),
      select: { fields: [{ fieldPath: 'name' }] },
      limit: 500,
    },
  });
  const nombres = {};
  for (const f of json || []) {
    if (!f.document) continue;
    const id = String(f.document.name || '').split('/').pop();
    nombres[id] = { nombre: valor(f.document.fields && f.document.fields.name) || id };
  }
  return nombres;
}

/** Los cursos, para saber de qué empresa es cada certificación. */
export async function traerCursos(cli) {
  const cursos = {};
  const json = await pedir(cli, 'runQuery', {
    structuredQuery: {
      from: desde_('courses', false),
      select: { fields: [{ fieldPath: 'name' }, { fieldPath: 'companyId' }, { fieldPath: 'certificationId' }] },
      limit: 2000,
    },
  });
  for (const f of json || []) {
    if (!f.document) continue;
    const id = String(f.document.name || '').split('/').pop();
    const c = f.document.fields || {};
    cursos[id] = { nombre: valor(c.name), empresa: valor(c.companyId), programa: valor(c.certificationId) };
  }
  return cursos;
}

/* ------------------------------------------------------------------- resumen */

/**
 * Lo que el tablero necesita, por mes. Pura: no habla con la red.
 *
 * Tres cifras distintas que no hay que confundir:
 *   · certificaciones: cuántas se completaron. Una persona puede completar
 *     dos programas el mismo mes y entonces son dos.
 *   · personas: cuántas personas distintas. Es la que pidió Mónica.
 *   · cumplen_permanencia: de esas certificaciones, cuántas llegan a los 360
 *     minutos de dedicación. El informe de Cencosud exige eso además de la
 *     nota, así que una persona puede estar completada aquí y salir «revisar
 *     permanencia» allá. Son dos criterios y el tablero muestra los dos.
 */
export function resumir(filas, programas = {}, cursos = {}) {
  const meses = {};
  const personasGlobal = new Set();

  for (const f of filas) {
    if (!f.mes) continue;
    const m = (meses[f.mes] = meses[f.mes] || {
      certificaciones: 0, cumplen: 0, medidas: 0, personas: new Set(),
      por_programa: {}, empresas: new Set(),
    });
    m.certificaciones += 1;
    if (f.persona) { m.personas.add(f.persona); personasGlobal.add(f.persona); }

    const curso = cursos[f.curso];
    if (curso && curso.empresa) m.empresas.add(curso.empresa);

    /* El programa del avance es el fiable; el del curso solo si falta. */
    const clave = f.programa || (curso && curso.programa) || '(sin programa)';
    const umbral = umbralDe(clave);

    /* La permanencia solo se cuenta donde hay umbral. Sumar los que no lo
       tienen al denominador diria que no cumplen, y no es que no cumplan: es
       que nadie ha dicho que deban. */
    if (umbral !== null) {
      m.medidas += 1;
      if (f.segundos >= umbral) m.cumplen += 1;
    }

    const p = (m.por_programa[clave] = m.por_programa[clave] || {
      certificaciones: 0, cumplen: 0, personas: new Set(), umbral,
    });
    p.certificaciones += 1;
    if (umbral !== null && f.segundos >= umbral) p.cumplen += 1;
    if (f.persona) p.personas.add(f.persona);
  }

  const por_mes = {};
  for (const [mes, m] of Object.entries(meses)) {
    por_mes[mes] = {
      certificaciones: m.certificaciones,
      personas: m.personas.size,
      /* Tres cifras y no una. cumplen_permanencia se lee SOBRE
         permanencia_medida, nunca sobre certificaciones: en junio de 2026
         serian 348 de 1.086 y eso leido mal es un 32 % catastrofico que no
         existe. permanencia_sin_umbral dice cuantas se quedaron fuera. */
      cumplen_permanencia: m.cumplen,
      permanencia_medida: m.medidas,
      permanencia_sin_umbral: m.certificaciones - m.medidas,
      empresas: [...m.empresas],
      por_programa: Object.entries(m.por_programa)
        .map(([id, p]) => ({
          id,
          nombre: (programas[id] && programas[id].nombre) || programas[id] || id,
          certificaciones: p.certificaciones,
          personas: p.personas.size,
          /* null, no cero: «no se mide» y «nadie cumple» no son lo mismo. */
          cumplen_permanencia: p.umbral === null ? null : p.cumplen,
          umbral_permanencia_seg: p.umbral,
        }))
        .sort((a, b) => b.certificaciones - a.certificaciones || String(a.nombre).localeCompare(String(b.nombre))),
    };
  }

  return {
    regla: REGLA,
    por_mes,
    total: {
      certificaciones: filas.filter((f) => f.mes).length,
      /* Personas distintas de toda la ventana. NO es la suma de los meses:
         quien se certifico en marzo y renovo en septiembre cuenta una vez
         aqui y dos si se suman los meses. */
      personas: personasGlobal.size,
      meses: Object.keys(por_mes).sort(),
    },
  };
}

/** Todo junto: trae, resume y comprueba. */
export async function armarCencosud({ desde, hasta }) {
  const cli = await crearCliente();

  /* El censo primero. Es una agregacion: no lee documentos, y es la cifra
     contra la que se comprueba que la paginacion no perdio paginas. */
  const censo = await contarColeccion(cli, 'certification-enrollments', true);

  const brutas = await traerAvances(cli);
  if (brutas.length !== censo) {
    throw new Error(
      `Cencosud: el censo dice ${censo} avances y la paginacion trajo ${brutas.length}. ` +
      'No se publica un corte que no cuadra consigo mismo.',
    );
  }

  const { filas: unicas, copias } = deduplicar(brutas);
  const filas = filtrarCompletadas(unicas, { desde, hasta });

  const [programas, cursos] = await Promise.all([traerProgramas(cli), traerCursos(cli)]);
  const resumen = resumir(filas, programas, cursos);

  /* Dos cosas que conviene que salgan publicadas, no solo en los registros:
     el factor de copia, porque si cambia las cifras se van al doble o a la
     mitad sin avisar; y cuantos avances hay sin completar, porque es el
     denominador de cualquier conversacion sobre desercion. */
  resumen.ventana = { desde, hasta };
  resumen.copias_por_documento = copias;
  resumen.avances_totales = unicas.length;
  resumen.avances_completados = filtrarCompletadas(unicas, { desde: '1970-01', hasta }).length;
  resumen.generado_en = new Date().toISOString();
  resumen.proyecto = cli.proyecto;
  return resumen;
}
