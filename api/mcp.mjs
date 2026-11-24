/* ---------------------------------------------------------------------------
 * /api/mcp — el tablero, para el Claude de la Dirección.
 *
 * Lo que decide qué contestar está en scripts/mcp.mjs y es una función pura.
 * Aquí solo va lo que necesita el mundo exterior: leer el token, comprobar
 * el origen, traer el corte y ejecutar la herramienta que toque.
 *
 * Es de SOLO LECTURA y de una sola vista. El token es fijo y lleva el rol
 * de Dirección pegado, así que quien tenga ese token ve lo que ve la
 * Dirección: la cartera con nombre y apellido de cada cliente, lo que falta
 * por facturar y el trabajo de cada persona. No hay forma de que un MCP con
 * token compartido distinga quién pregunta —eso exigiría OAuth— así que el
 * token es el perímetro entero y se revoca cambiando la variable.
 *
 * Y devuelve TEXTO, no JSON crudo. Todas las barandas de este proyecto están
 * escritas en la prosa: que un mes en curso va a medias, que la cartera es
 * bruta, que un cliente que aparece por primera vez no es uno perdido. Si se
 * mandaran los números pelados, el modelo del otro lado los recompondría a
 * su manera y afirmaría con soltura justo lo que llevamos meses impidiendo.
 * ------------------------------------------------------------------------- */
import { traerTodasLasFuentes } from '../scripts/llamadas.mjs';
import { armarCorte } from '../scripts/mapeo.mjs';
import { leerCartera, leerConciliacion, leerTrello } from '../scripts/datos.mjs';
import { adjuntarCartera, adjuntarTrello } from '../scripts/alertas.mjs';
import { fichaDelCorte } from './chat.mjs';
import { responder, resultado, tokenValido, ERR } from '../scripts/mcp.mjs';

export const config = { maxDuration: 60 };

/** Parte la ficha en secciones por sus títulos de nivel dos. */
export function secciones(texto) {
  const fuera = new Map();
  let actual = '(cabecera)', buf = [];
  for (const l of String(texto).split('\n')) {
    const m = /^## (.+)$/.exec(l);
    if (m) { fuera.set(actual, buf.join('\n').trim()); actual = m[1]; buf = []; continue; }
    buf.push(l);
  }
  fuera.set(actual, buf.join('\n').trim());
  return fuera;
}

/** Las secciones cuyo título empiece por alguno de estos trozos. */
const tomar = (mapa, prefijos) => {
  const partes = [];
  for (const [titulo, cuerpo] of mapa) {
    if (titulo === '(cabecera)') { partes.push(cuerpo); continue; }
    if (prefijos.some((p) => titulo.startsWith(p))) partes.push(`## ${titulo}\n${cuerpo}`);
  }
  return partes.filter(Boolean).join('\n\n');
};

const HERRAMIENTAS = {
  corte_del_mes: {
    name: 'corte_del_mes',
    title: 'El corte del mes',
    description:
      'Las cifras de cabecera de BPM: certificaciones y personas del mes, índice de salud, ' +
      'comparativo contra el año pasado y la serie mensual. Incluye cómo comparar un mes en ' +
      'curso contra uno cerrado, que no se hace con los totales en bruto.',
    inputSchema: { type: 'object', additionalProperties: false },
    correr: (corte) => tomar(secciones(fichaDelCorte(corte)), [
      'Meses del corte', 'CÓMO COMPARAR', 'Índice de salud', 'Comparativo', 'Serie mensual',
    ]),
  },
  alertas: {
    name: 'alertas',
    title: 'Lo que hay que mirar',
    description:
      'Las alertas vigentes del tablero, de más grave a menos: qué pasa, por qué importa y ' +
      'qué hacer. Cubre volumen, vencimientos, cartera, facturación pendiente, trámites, ' +
      'Alimentia y Trello.',
    inputSchema: { type: 'object', additionalProperties: false },
    correr: (corte) => {
      const al = corte.alertas || [];
      if (!al.length) return 'Ningún umbral superado en este corte.';
      const sev = { critica: 'CRÍTICA', atencion: 'Atención', aviso: 'Aviso' };
      return [
        `Alertas del corte del ${corte.corte}: ${al.length}.`,
        '',
        ...al.map((a) => [
          `[${sev[a.severidad] || a.severidad}] ${a.titulo}`,
          a.detalle ? `  ${a.detalle}` : '',
          a.accion ? `  Qué hacer: ${a.accion}` : '',
        ].filter(Boolean).join('\n')),
      ].join('\n');
    },
  },
};

const origenValido = (req) => {
  const o = req.headers.origin;
  if (!o) return true;            // las peticiones de servidor no llevan Origin
  const h = req.headers.host || '';
  try { return new URL(o).host === h; } catch { return false; }
};

const tokenDe = (req) => {
  const a = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(a);
  if (m) return m[1].trim();
  return req.headers['x-tablero-token'] || null;
};

export default async function handler(req, res) {
  /* Esta revisión quitó el canal de GET. Lo que llegue por ahí es un cliente
     viejo, y la norma dice que se le conteste 405. */
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ jsonrpc: '2.0', id: null,
      error: { code: ERR.metodo, message: 'Este servidor solo admite POST' } });
  }

  let cuerpo;
  try { cuerpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}; }
  catch {
    return res.status(400).json({ jsonrpc: '2.0', id: null,
      error: { code: ERR.parse, message: 'El cuerpo no es JSON' } });
  }

  const d = responder(cuerpo, req.headers || {}, {
    herramientas: HERRAMIENTAS,
    autorizado: tokenValido(tokenDe(req), process.env.MCP_TOKEN),
    origenValido: origenValido(req),
  });

  if (!d.ejecutar) {
    if (d.cuerpo === null) return res.status(d.estado).end();
    return res.status(d.estado).json(d.cuerpo);
  }

  /* Solo aquí se tocan los datos, y solo después de que el token valiera. */
  try {
    const periodo = new Date().toISOString().slice(0, 7);
    const { muestras, fallaron } = await traerTodasLasFuentes(periodo);
    const corte = armarCorte(muestras, {}, fallaron);
    const [cartera, conciliacion, trello] = await Promise.all([leerCartera(), leerConciliacion(), leerTrello()]);
    adjuntarCartera(corte, cartera, conciliacion);
    adjuntarTrello(corte, trello);
    const texto = HERRAMIENTAS[d.ejecutar.nombre].correr(corte, d.ejecutar.argumentos);
    return res.status(200).json(resultado(d.ejecutar.id, texto, false));
  } catch (e) {
    /* Que una herramienta falle no es un error del protocolo: es un
       resultado con isError, y el modelo del otro lado puede decirlo. */
    console.error('[mcp]', e);
    return res.status(200).json(resultado(d.ejecutar.id,
      'No se pudo leer el tablero en este momento: ' + e.message, true));
  }
}
