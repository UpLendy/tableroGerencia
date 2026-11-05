/* ---------------------------------------------------------------------------
 * /api/corte — el tablero pide aquí sus datos.
 *
 * Hace los once llamados a la plataforma del lado del servidor y devuelve el
 * corte ya armado. El token vive como variable de entorno del proyecto y
 * nunca llega al navegador; por eso esta función existe.
 *
 * Una sola petición desde la página en vez de once, y el mapeo queda en un
 * solo sitio, compartido con el proceso programado.
 * ------------------------------------------------------------------------- */
import { traerTodo, BASE_POR_DEFECTO } from '../scripts/llamadas.mjs';
import { armarCorte } from '../scripts/mapeo.mjs';

export const config = { maxDuration: 120 };

const PERIODO_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function handler(req, res) {
  const token = process.env.TABLERO_API_TOKEN;
  if (!token) {
    return res.status(500).json({
      ok: false,
      error: 'falta_token',
      mensaje: 'El proyecto no tiene configurada la variable TABLERO_API_TOKEN.',
    });
  }

  /* El periodo llega del tablero o se toma el mes en curso. Se valida antes de
     tocar nada: esto es un endpoint público y no debe aceptar cualquier cosa. */
  const pedido = (req.query && req.query.periodo) || '';
  const periodo = PERIODO_VALIDO.test(pedido) ? pedido : new Date().toISOString().slice(0, 7);

  const t0 = Date.now();
  try {
    const { muestras, tiempos, total_ms } = await traerTodo({
      base: process.env.TABLERO_API_BASE || BASE_POR_DEFECTO,
      token,
      periodo,
    });

    const corte = armarCorte(muestras);
    corte.origen = 'vivo';
    corte.tiempos_ms = { ...tiempos, total: total_ms };

    /* Los endpoints de la plataforma ya cachean quince minutos el mes en curso.
       Replicarlo aquí evita que cada visita dispare once llamados. */
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json(corte);
  } catch (e) {
    /* Que el tablero pueda distinguir "la plataforma no respondió" de
       "el corte está mal", y caer al archivo publicado sin quedarse en blanco. */
    return res.status(502).json({
      ok: false,
      error: 'plataforma_no_responde',
      mensaje: String(e.message || e),
      periodo,
      ms: Date.now() - t0,
    });
  }
}
