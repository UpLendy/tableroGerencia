/* ---------------------------------------------------------------------------
 * /api/publicado — el corte ya publicado, pero con sesión.
 *
 * El tablero pintaba primero data/corte.json, un archivo estático, y refrescaba
 * en vivo después. Esa primera pintada es lo que hace que la pantalla no esté
 * vacía durante los segundos que tarda la consulta a las tres plataformas.
 *
 * El problema es que un archivo estático lo puede pedir cualquiera: bastaba
 * escribir /data/corte.json para tener ingresos, precios y la carga de cada
 * ingeniero con nombre propio, sin pasar por el tablero. Por eso /data/ dejó de
 * servirse y el corte publicado sale por aquí, donde hay que presentar sesión.
 *
 * Es rápido porque no llama a ninguna plataforma: lee el archivo que el proceso
 * nocturno dejó en el repositorio.
 * ------------------------------------------------------------------------- */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rolDe, veTodo } from '../scripts/sesion.mjs';
import { despojarParaEquipo } from '../scripts/vista.mjs';

export const config = { includeFiles: ['data/**'] };

/** Vercel no garantiza desde dónde corre la función: se prueban los dos sitios. */
async function leer(nombre) {
  const rutas = [
    new URL(`../data/${nombre}`, import.meta.url),
    join(process.cwd(), 'data', nombre),
  ];
  let ultimo;
  for (const r of rutas) {
    try { return JSON.parse(await readFile(r, 'utf8')); }
    catch (e) { ultimo = e; }
  }
  throw ultimo;
}

export default async function handler(req, res) {
  const rol = rolDe(req);
  if (!rol) return res.status(401).json({ ok: false, error: 'sin_sesion' });

  try {
    /* Gerencia lee el corte completo. Equipo lee el suyo, y si por lo que sea
       no estuviera publicado, se despoja el completo aquí mismo: nunca se le
       entrega el de Gerencia como último recurso. */
    if (veTodo(rol)) {
      const c = await leer('corte.json');
      c.origen = 'archivo';
      return res.status(200).json(c);
    }

    let c;
    try { c = await leer('corte-equipo.json'); }
    catch { c = despojarParaEquipo(await leer('corte.json')); }
    c.origen = 'archivo';
    return res.status(200).json(despojarParaEquipo(c));
  } catch (e) {
    console.error('[publicado] no se pudo leer el corte:', e);
    return res.status(503).json({
      ok: false,
      error: 'sin_corte_publicado',
      mensaje: 'No hay corte publicado disponible.',
    });
  }
}
