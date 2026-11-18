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
import { rolDe, veTodo } from '../scripts/sesion.mjs';
import { despojarParaEquipo } from '../scripts/vista.mjs';
import { leerDato, leerCartera } from '../scripts/datos.mjs';
import { adjuntarCartera } from '../scripts/alertas.mjs';

export const config = { includeFiles: ['data/**'] };

const leer = leerDato;

export default async function handler(req, res) {
  const rol = rolDe(req);
  if (!rol) return res.status(401).json({ ok: false, error: 'sin_sesion' });

  try {
    /* Gerencia lee el corte completo. Equipo lee el suyo, y si por lo que sea
       no estuviera publicado, se despoja el completo aquí mismo: nunca se le
       entrega el de Gerencia como último recurso. */
    /* La cartera la produce otro proceso y vive en otro archivo, porque dos
       flujos escribiendo el mismo archivo se pisan al empujar. Se une aquí,
       al servir, y si todavía no está publicada el tablero sale igual. */
    const cartera = await leerCartera();

    if (veTodo(rol)) {
      const c = await leer('corte.json');
      adjuntarCartera(c, cartera);
      c.origen = 'archivo';
      return res.status(200).json(c);
    }

    /* Un solo archivo publicado. La vista de Equipo se despoja aquí, en cada
       petición, en vez de mantener un segundo archivo que pueda quedar
       desfasado del primero. */
    const completo = await leer('corte.json');
    adjuntarCartera(completo, cartera);
    const c = despojarParaEquipo(completo);
    c.origen = 'archivo';
    return res.status(200).json(c);
  } catch (e) {
    console.error('[publicado] no se pudo leer el corte:', e);
    return res.status(503).json({
      ok: false,
      error: 'sin_corte_publicado',
      mensaje: 'No hay corte publicado disponible.',
    });
  }
}
