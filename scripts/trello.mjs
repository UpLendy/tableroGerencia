/* ---------------------------------------------------------------------------
 * trello.mjs — lee los tableros de Trello de BPM. Solo lectura.
 *
 * El método va escrito a mano, como en llamadas.mjs: este cliente no sabe
 * hacer otra cosa que pedir. Hubo una versión que escribía tarjetas y se
 * revirtió entera; si algún día hace falta escribir, que sea una decisión
 * deliberada y no algo que se pueda colar por aquí.
 *
 * Lo que mide y por qué, sacado de mirar los dos tableros reales:
 *
 *   · El responsable es el NOMBRE DE LA COLUMNA, no el miembro asignado. De
 *     285 tarjetas entre los dos tableros, 1 tenía miembro. En el tablero
 *     grande las columnas son Ana, Sebas, Alejandro, Mónica y Tomás; en el
 *     otro son temas. Así que esto no clasifica columnas: las cuenta y las
 *     nombra como están, y quien lee sabe si "Ana" es una persona.
 *
 *   · Lo vencido es la señal fuerte: 137 de 222 tarjetas llevan fecha en el
 *     tablero grande y 59 de 63 en el otro. Una tarjeta vencida y sin marcar
 *     hecha es un hecho, no una interpretación.
 *
 *   · Lo quieto depende del tablero y por eso no se informa por tarjeta: la
 *     mediana de un tablero es 1 día y la del otro 10. Una tarjeta sola
 *     quieta no dice nada. Una COLUMNA ENTERA sin tocarse sí: "Ventas" con
 *     sus seis tarjetas a 28 días es que nadie está mirando esa columna.
 *
 *   · Y las columnas de historial se excluyen. En el tablero grande son 70
 *     de 222 tarjetas: contarlas haría que el informe dijera que hay 222
 *     pendientes cuando hay 152, y que la columna más grande fuera trabajo
 *     ya terminado. Se excluyen por patrón de nombre siguiendo la
 *     convención que ellos mismos usan, y el extractor imprime siempre qué
 *     excluyó, para que nunca descarte nada en silencio.
 * ------------------------------------------------------------------------- */

export const REGLA = 'trello-v1';
const BASE = 'https://api.trello.com/1';

/** Columnas que no son trabajo pendiente. Su convención, no la nuestra. */
export const PATRONES_HISTORIAL = [
  /historial/i, /marcadas como hechas/i, /\bhechas\b/i, /\bpagadas\b/i, /^🗂️/u, /^✅/u,
];
export const esHistorial = (nombre) =>
  PATRONES_HISTORIAL.some((p) => p.test(String(nombre || '')));

/** Días sin moverse a partir de los cuales una columna entera preocupa. */
export const DIAS_QUIETA = 14;

const dias = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : null);

/* El método es GET y no hay forma de pedir otra cosa. */
async function pedir(ruta, { clave, token, ...params }) {
  const u = new URL(BASE + ruta);
  u.searchParams.set('key', clave);
  u.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(30000) });
  const texto = await r.text();
  if (!r.ok) throw new Error(`trello ${ruta}: HTTP ${r.status} · ${texto.slice(0, 200)}`);
  try { return JSON.parse(texto); }
  catch { throw new Error(`trello ${ruta}: la respuesta no es JSON`); }
}

/** Lo crudo de un tablero: su nombre, sus columnas y sus tarjetas abiertas. */
export async function traerTablero(id, credenciales) {
  const [tablero, listas, tarjetas] = await Promise.all([
    pedir(`/boards/${id}`, { ...credenciales, fields: 'name,url' }),
    pedir(`/boards/${id}/lists`, { ...credenciales, fields: 'id,name' }),
    pedir(`/boards/${id}/cards`, { ...credenciales,
      fields: 'id,name,idList,due,dueComplete,dateLastActivity,shortUrl' }),
  ]);
  /* Los nombres vienen de Trello como los escribió una persona, con espacios
     de sobra al final. «Tablero oficina 2 » dentro de una frase se nota. */
  const limpiar = (x) => String(x || '').trim();
  return {
    id, nombre: limpiar(tablero.name), url: tablero.url,
    listas: listas.map((l) => ({ ...l, name: limpiar(l.name) })),
    tarjetas: tarjetas.map((c) => ({ ...c, name: limpiar(c.name) })),
  };
}

/**
 * Convierte lo crudo en lo que el tablero gerencial necesita. Separado de la
 * red a propósito: así se prueba entero sin credenciales.
 */
export function resumirTablero({ id, nombre, url, listas, tarjetas }, { ahora = Date.now() } = {}) {
  const diasDe = (iso) => (iso ? Math.floor((ahora - Date.parse(iso)) / 864e5) : null);
  const vencida = (c) => !!c.due && c.dueComplete !== true && Date.parse(c.due) < ahora;

  const porLista = new Map();
  for (const l of listas) {
    porLista.set(l.id, {
      id: l.id, nombre: l.name, historial: esHistorial(l.name),
      vivas: 0, vencidas: 0, sin_fecha: 0, quietas: 0, dias_mas_quieta: 0,
    });
  }

  const vencidas = [];
  let sueltas = 0;
  for (const c of tarjetas) {
    const l = porLista.get(c.idList);
    if (!l) { sueltas++; continue; }
    if (l.historial) { l.vivas++; continue; }
    l.vivas++;
    const q = diasDe(c.dateLastActivity);
    if (q !== null) {
      if (q > l.dias_mas_quieta) l.dias_mas_quieta = q;
      if (q >= DIAS_QUIETA) l.quietas++;
    }
    if (!c.due) l.sin_fecha++;
    if (vencida(c)) {
      l.vencidas++;
      vencidas.push({
        tablero: nombre, tablero_id: id, columna: l.nombre,
        nombre: c.name, dias: Math.max(0, Math.floor((ahora - Date.parse(c.due)) / 864e5)),
        url: c.shortUrl || null,
      });
    }
  }

  const columnas = [...porLista.values()];
  const vivas = columnas.filter((l) => !l.historial);
  const excluidas = columnas.filter((l) => l.historial)
    .map((l) => ({ nombre: l.nombre, tarjetas: l.vivas }));

  /* Una columna parada: tiene tarjetas y TODAS llevan quietas más de los
     días del umbral. Una tarjeta suelta quieta no dice nada; una columna
     entera sin tocar es que nadie la está mirando. */
  const paradas = vivas
    .filter((l) => l.vivas > 0 && l.quietas === l.vivas)
    .map((l) => ({ tablero: nombre, columna: l.nombre, tarjetas: l.vivas, dias: l.dias_mas_quieta }));

  return {
    id, nombre, url,
    vivas: vivas.reduce((a, l) => a + l.vivas, 0),
    vencidas: vivas.reduce((a, l) => a + l.vencidas, 0),
    sin_fecha: vivas.reduce((a, l) => a + l.sin_fecha, 0),
    columnas: vivas.map(({ historial, ...l }) => l)
      .sort((a, b) => b.vivas - a.vivas),
    excluidas,
    tarjetas_sin_columna: sueltas,
    lista_vencidas: vencidas.sort((a, b) => b.dias - a.dias),
    columnas_paradas: paradas,
  };
}

/** El bloque entero, de varios tableros. */
export function armarTrello(resumenes, { generado_en = new Date().toISOString() } = {}) {
  const vencidas = resumenes.flatMap((t) => t.lista_vencidas).sort((a, b) => b.dias - a.dias);
  const paradas = resumenes.flatMap((t) => t.columnas_paradas).sort((a, b) => b.dias - a.dias);
  return {
    regla: REGLA, generado_en, dias_quieta: DIAS_QUIETA,
    tableros: resumenes.map(({ lista_vencidas, columnas_paradas, ...t }) => t),
    vencidas, columnas_paradas: paradas,
    resumen: {
      tableros: resumenes.length,
      vivas: resumenes.reduce((a, t) => a + t.vivas, 0),
      vencidas: vencidas.length,
      sin_fecha: resumenes.reduce((a, t) => a + t.sin_fecha, 0),
      columnas_paradas: paradas.length,
      excluidas: resumenes.reduce((a, t) => a + t.excluidas.reduce((b, e) => b + e.tarjetas, 0), 0),
    },
  };
}

export const CONFIG = {
  clave: () => process.env.TRELLO_CLAVE,
  token: () => process.env.TRELLO_TOKEN,
  tableros: () => String(process.env.TRELLO_TABLEROS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
};
