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
import { traerTodasLasFuentes } from '../scripts/llamadas.mjs';
import { armarCorte } from '../scripts/mapeo.mjs';
import { despojarParaEquipo } from '../scripts/vista.mjs';
import { rolDe } from '../scripts/sesion.mjs';

export const config = { maxDuration: 120 };

const PERIODO_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function handler(req, res) {
  /* Solo formación es imprescindible. Sin su token no hay corte; sin los
     otros dos, el corte sale y esas plataformas quedan declaradas ausentes. */
  /* La vista la decide el rol de la sesión, nunca un parámetro de la URL.
     Antes bastaba borrar ?vista=equipo para ver el corte de Gerencia. */
  const rol = rolDe(req);
  if (!rol) {
    return res.status(401).json({
      ok: false,
      error: 'sin_sesion',
      mensaje: 'Hay que entrar al tablero para consultar el corte.',
    });
  }

  if (!process.env.TABLERO_API_TOKEN) {
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
    const { muestras, tiempos, fallaron } = await traerTodasLasFuentes(periodo);

    const corte = armarCorte(muestras, {}, fallaron);
    corte.origen = 'vivo';
    corte.tiempos_ms = { ...tiempos, total: Date.now() - t0 };

    /* La vista de Equipo no recibe dinero ni cifras por persona. Se despoja
       aquí, antes de salir del servidor: ocultarlo en pantalla no cumpliría
       el criterio del bloque D, porque el dato igual habría viajado. */
    const salida = rol === 'gerencia' ? corte : despojarParaEquipo(corte);

    /* Los endpoints de la plataforma ya cachean quince minutos el mes en curso.
       Replicarlo aquí evita que cada visita dispare once llamados. */
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    /* Dos respuestas distintas en la misma ruta: la caché tiene que separarlas. */
    /* Dos respuestas distintas en la misma ruta segun la cookie: sin esto la
       caché compartida podria servirle a Equipo lo que armó para Gerencia. */
    res.setHeader('Vary', 'Cookie');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    return res.status(200).json(salida);
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
