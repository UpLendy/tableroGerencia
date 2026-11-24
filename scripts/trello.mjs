/* ---------------------------------------------------------------------------
 * trello.mjs — lleva las alertas del corte a un tablero de Trello.
 *
 * Es la primera integración de este proyecto que ESCRIBE en algo de alguien.
 * Todo lo demás —Siigo, la plataforma de formación, trámites, Alimentia— es
 * de solo lectura por construcción: en llamadas.mjs el método GET está
 * escrito a mano y no hay forma de pedir otra cosa. Aquí hace falta escribir,
 * así que la disciplina equivalente es una lista blanca: este cliente sabe
 * hacer exactamente cuatro cosas, y cualquier otra petición se rechaza antes
 * de salir. No archiva, no borra, no mueve tarjetas de lista y no toca el
 * tablero. Si una alerta desaparece, su tarjeta recibe una nota; cerrarla es
 * decisión de quien la esté trabajando, no nuestra.
 *
 * La idempotencia se apoya en el id de la alerta, que es estable entre
 * cortes: la tarjeta lo lleva escrito en la descripción y por ahí se la
 * reconoce al día siguiente. Sin eso, esto sería una máquina de duplicados.
 *
 * QUÉ SE ENVÍA, y por qué el valor por defecto es el que es: solo las alertas
 * con para='todos'. Las de gerencia nombran lo que debe cada cliente, cuánto
 * se dejó de facturar y a veces a qué ingeniero. Un tablero de Trello suele
 * estar compartido con el equipo, y el tablero gerencial lleva meses
 * separando esas dos vistas en el servidor para que esa información no viaje.
 * Mandarla a Trello por omisión desharía ese trabajo sin que nadie lo
 * decidiera. Se activa a propósito con TRELLO_INCLUIR_GERENCIA=1, y quien lo
 * active tiene que saber quién mira ese tablero.
 * ------------------------------------------------------------------------- */

export const BASE = 'https://api.trello.com/1';

/** La marca que convierte una tarjeta en «la tarjeta de esta alerta». */
export const MARCA = 'tablero-gerencial · alerta';
const marcaDe = (id) => `${MARCA}: ${id}`;
const RESUELTA = 'Ya no aparece en el corte del';

export const CONFIG = {
  clave: () => process.env.TRELLO_CLAVE,
  token: () => process.env.TRELLO_TOKEN,
  lista: () => process.env.TRELLO_LISTA,
  severidades: () => String(process.env.TRELLO_SEVERIDADES || 'critica')
    .split(',').map((s) => s.trim()).filter(Boolean),
  incluirGerencia: () => process.env.TRELLO_INCLUIR_GERENCIA === '1',
};

/* --------------------------------------------------------- lista blanca
   Cada entrada es una operación que este cliente puede hacer. Lo que no
   está aquí no se puede pedir, y eso incluye DELETE en cualquier forma y
   cualquier PUT que lleve `closed` o `idList`, que son archivar y mover. */
const PERMITIDO = [
  { nombre: 'leer-lista',   metodo: 'GET',  ruta: /^\/lists\/[\w-]+\/cards$/ },
  /* Para la puesta en marcha hace falta averiguar el id de la lista, y eso
     obliga a leer las listas del tablero. Se permite nombrando el tablero,
     que se saca de su URL; lo que sigue prohibido es preguntar por los
     tableros de la cuenta, que es curiosear y no hace falta para nada. */
  { nombre: 'leer-listas',  metodo: 'GET',  ruta: /^\/boards\/[\w-]+\/lists$/ },
  { nombre: 'crear',        metodo: 'POST', ruta: /^\/cards$/ },
  { nombre: 'actualizar',   metodo: 'PUT',  ruta: /^\/cards\/[\w-]+$/, campos: ['name', 'desc'] },
  { nombre: 'comentar',     metodo: 'POST', ruta: /^\/cards\/[\w-]+\/actions\/comments$/ },
];

export function permiso(metodo, ruta, cuerpo) {
  const p = PERMITIDO.find((x) => x.metodo === metodo && x.ruta.test(ruta));
  if (!p) return { ok: false, por: `${metodo} ${ruta} no está en la lista de lo permitido` };
  if (p.campos) {
    const sobra = Object.keys(cuerpo || {}).filter((k) => !p.campos.includes(k));
    if (sobra.length) return { ok: false, por: `${p.nombre} no puede tocar: ${sobra.join(', ')}` };
  }
  return { ok: true, nombre: p.nombre };
}

async function pedir({ metodo, ruta, cuerpo, clave, token, buscar }) {
  const v = permiso(metodo, ruta, cuerpo);
  if (!v.ok) throw new Error(`trello: ${v.por}`);
  const url = new URL(BASE + ruta);
  url.searchParams.set('key', clave);
  url.searchParams.set('token', token);
  for (const [k, x] of Object.entries(buscar || {})) url.searchParams.set(k, String(x));

  const res = await fetch(url, {
    method: metodo,
    headers: cuerpo ? { 'content-type': 'application/json' } : undefined,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`trello ${ruta}: HTTP ${res.status} · ${texto.slice(0, 200)}`);
  try { return texto ? JSON.parse(texto) : null; }
  catch { throw new Error(`trello ${ruta}: la respuesta no es JSON`); }
}

/** El texto de la tarjeta. La marca va al final y visible: también le sirve
 *  a quien la lea para saber de dónde salió y que no la escribió una persona. */
export function cuerpoDeTarjeta(a, corte) {
  const sev = { critica: 'CRÍTICA', atencion: 'Atención', aviso: 'Aviso' }[a.severidad] || a.severidad;
  return [
    `**${sev}**`,
    a.detalle || '',
    a.accion ? `\n**Qué hacer:** ${a.accion}` : '',
    `\n---`,
    `Generada por el tablero gerencial${corte ? ` · corte del ${corte}` : ''}.`,
    `Se actualiza sola mientras la alerta siga apareciendo.`,
    marcaDe(a.id),
  ].filter(Boolean).join('\n');
}

/** Qué alertas van al tablero, y por qué se quedan fuera las demás. */
export function elegibles(alertas, { severidades, incluirGerencia }) {
  return (alertas || []).filter((a) =>
    severidades.includes(a.severidad) &&
    (incluirGerencia || a.para !== 'gerencia'));
}

/** El id de alerta que lleva una tarjeta, o null si no la escribió el tablero. */
export const idDeTarjeta = (c) => {
  const m = new RegExp(`${MARCA}:\\s*([^\\s]+)`).exec(String(c && c.desc) || '');
  return m ? m[1] : null;
};

/**
 * Decide qué hacer, sin hacer nada. Separado a propósito: así el plan se
 * puede mirar antes de ejecutarlo y se puede probar sin red ni credenciales.
 */
export function planear(alertas, tarjetas, opciones) {
  const { severidades, incluirGerencia, corte } = opciones;
  const quiero = elegibles(alertas, { severidades, incluirGerencia });
  const mias = (tarjetas || []).filter((c) => idDeTarjeta(c));
  const porId = new Map(mias.map((c) => [idDeTarjeta(c), c]));
  const plan = [];

  for (const a of quiero) {
    const ya = porId.get(a.id);
    const desc = cuerpoDeTarjeta(a, corte);
    if (!ya) { plan.push({ accion: 'crear', id: a.id, nombre: a.titulo, desc }); continue; }
    /* Solo se escribe si de verdad cambió algo: una tarjeta que se actualiza
       cada noche sin cambiar sube al principio del tablero y hace ruido. */
    if (ya.name !== a.titulo || ya.desc !== desc) {
      plan.push({ accion: 'actualizar', id: a.id, tarjeta: ya.id, nombre: a.titulo, desc });
    } else {
      plan.push({ accion: 'sin-cambios', id: a.id, tarjeta: ya.id });
    }
  }

  /* Las que ya no están. Se avisa una vez: si la descripción ya lleva la
     nota, no se vuelve a comentar cada noche. Y no se archiva: puede haber
     alguien trabajando esa tarjeta. */
  const vivos = new Set(quiero.map((a) => a.id));
  for (const c of mias) {
    const id = idDeTarjeta(c);
    if (vivos.has(id)) continue;
    if (String(c.desc || '').includes(RESUELTA)) { plan.push({ accion: 'ya-avisada', id, tarjeta: c.id }); continue; }
    plan.push({
      accion: 'avisar-resuelta', id, tarjeta: c.id,
      comentario: `${RESUELTA} ${corte || 'de hoy'}. El tablero no la archiva: ciérrala tú si ya está resuelta.`,
      desc: `${c.desc}\n\n_${RESUELTA} ${corte || 'de hoy'}._`,
    });
  }
  return plan;
}

/** Ejecuta un plan. Con ensayo=true no toca nada y devuelve lo que haría. */
/** Las listas de un tablero, para la puesta en marcha. Solo lectura. */
export async function listasDe(idTablero, { clave = CONFIG.clave(), token = CONFIG.token() } = {}) {
  if (!clave || !token) throw new Error('faltan TRELLO_CLAVE o TRELLO_TOKEN');
  const ls = await pedir({ metodo: 'GET', ruta: `/boards/${idTablero}/lists`, clave, token,
    buscar: { fields: 'id,name' } });
  return (ls || []).map((l) => ({ id: l.id, nombre: l.name }));
}

export async function sincronizar(alertas, opciones = {}) {
  const clave = opciones.clave ?? CONFIG.clave();
  const token = opciones.token ?? CONFIG.token();
  const lista = opciones.lista ?? CONFIG.lista();
  const ensayo = opciones.ensayo === true;
  const o = {
    severidades: opciones.severidades ?? CONFIG.severidades(),
    incluirGerencia: opciones.incluirGerencia ?? CONFIG.incluirGerencia(),
    corte: opciones.corte || null,
  };
  if (!clave || !token || !lista) {
    return { ok: false, error: 'faltan TRELLO_CLAVE, TRELLO_TOKEN o TRELLO_LISTA', plan: [] };
  }

  const tarjetas = await pedir({ metodo: 'GET', ruta: `/lists/${lista}/cards`, clave, token,
    buscar: { fields: 'id,name,desc' } });
  const plan = planear(alertas, tarjetas, o);
  if (ensayo) return { ok: true, ensayo: true, plan, tarjetas_en_la_lista: (tarjetas || []).length };

  const hechas = [];
  for (const p of plan) {
    if (p.accion === 'crear') {
      const t = await pedir({ metodo: 'POST', ruta: '/cards', clave, token,
        buscar: { idList: lista, name: p.nombre, desc: p.desc, pos: 'top' } });
      hechas.push({ ...p, tarjeta: t && t.id });
    } else if (p.accion === 'actualizar') {
      await pedir({ metodo: 'PUT', ruta: `/cards/${p.tarjeta}`, clave, token,
        cuerpo: { name: p.nombre, desc: p.desc } });
      hechas.push(p);
    } else if (p.accion === 'avisar-resuelta') {
      await pedir({ metodo: 'POST', ruta: `/cards/${p.tarjeta}/actions/comments`, clave, token,
        buscar: { text: p.comentario } });
      await pedir({ metodo: 'PUT', ruta: `/cards/${p.tarjeta}`, clave, token, cuerpo: { desc: p.desc } });
      hechas.push(p);
    } else {
      hechas.push(p);
    }
  }
  return { ok: true, plan: hechas };
}
