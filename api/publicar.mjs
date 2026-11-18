/* ---------------------------------------------------------------------------
 * /api/publicar — el corte diario, corriendo en Vercel en vez de en GitHub.
 *
 * Por qué está aquí y no en un flujo de GitHub Actions: el escudo del hosting
 * (Imunify360) devuelve 403 a las IPs de GitHub Actions antes de que Laravel
 * conteste. Son más de 2.500 rangos que además rotan, así que no hay lista
 * blanca que valga. Vercel sí alcanza la plataforma —el tablero consulta en
 * vivo desde aquí todos los días— y por eso el corte se mudó a este lado.
 *
 * Hace exactamente lo mismo que hacía el flujo: consulta, congela, comprueba
 * la vista de Equipo y publica. Lo único distinto es cómo escribe: en vez de
 * `git push`, la API de contenidos de GitHub. El commit dispara el despliegue
 * de Vercel igual que antes, así que el tablero se actualiza solo.
 *
 * Lo que NO hace: no escribe en la plataforma, no borra nada, y si la vista
 * de Equipo dejara escapar dinero, no publica y lo dice.
 *
 * Variables que necesita en Vercel:
 *   TABLERO_API_TOKEN, TRAMITES_API_TOKEN, ALIMENTIA_API_TOKEN
 *   CRON_SECRET     el que Vercel manda en Authorization al disparar el cron
 *   GITHUB_TOKEN    PAT con escritura de contenido SOLO en este repositorio
 *   GITHUB_REPO     "UpLendy/tableroGerencia"  (opcional, ese es el defecto)
 * ------------------------------------------------------------------------- */
import { traerTodasLasFuentes } from '../scripts/llamadas.mjs';
import { construir, resumir, registroVacio } from '../scripts/construir.mjs';
import { leerDato } from '../scripts/datos.mjs';
import { publicarArchivos } from '../scripts/github.mjs';

/* data/** tiene que viajar en el paquete de la función: de ahí sale el
   registro de meses cerrados, que es la memoria del congelado. */
export const config = { maxDuration: 120, includeFiles: ['data/**'] };

const REPO = process.env.GITHUB_REPO || 'UpLendy/tableroGerencia';
const RAMA = process.env.GITHUB_BRANCH || 'main';

export default async function handler(req, res) {
  /* Vercel manda el CRON_SECRET en Authorization cuando dispara un cron. Sin
     esto la ruta quedaría abierta: cualquiera podría forzar un commit. */
  const secreto = process.env.CRON_SECRET;
  if (!secreto) {
    return res.status(503).json({ ok: false, error: 'sin_cron_secret',
      mensaje: 'Falta configurar CRON_SECRET en Vercel.' });
  }
  if (req.headers.authorization !== `Bearer ${secreto}`) {
    return res.status(401).json({ ok: false, error: 'no_autorizado' });
  }
  /* El token de GitHub solo se exige si de verdad se va a escribir. Con
     ?devolver=1 o ?ensayo=1 la función no commitea nada y no hace falta. */
  const soloLeer = /[?&](devolver|ensayo)=1/.test(req.url || '');
  if (!soloLeer && !process.env.GITHUB_TOKEN) {
    return res.status(503).json({ ok: false, error: 'sin_github_token',
      mensaje: 'Falta configurar GITHUB_TOKEN en Vercel. Mientras tanto, ' +
               'usa ?devolver=1 y publica los archivos a mano.' });
  }

  /* ?periodo= para poder relanzar un mes a mano desde el navegador; sin él,
     el mes en curso, que es lo que hace el cron. */
  const pedido = (req.query && req.query.periodo) || '';
  const periodo = /^\d{4}-(0[1-9]|1[0-2])$/.test(pedido)
    ? pedido : new Date().toISOString().slice(0, 7);
  /* ?ensayo=1 hace todo menos escribir: sirve para probar la ruta sin dejar
     un commit por el camino.

     ?devolver=1 además devuelve los dos archivos armados, para guardarlos y
     commitearlos a mano. Existe porque el token de GitHub solo hace falta
     para ESCRIBIR: quien tenga `git push` puede publicar el corte sin que la
     función tenga credenciales de escritura. Sirve mientras se consigue el
     token, y sigue sirviendo después para republicar un mes concreto. */
  const ensayo = String((req.query && req.query.ensayo) || '') === '1';
  const devolver = String((req.query && req.query.devolver) || '') === '1';

  const t0 = Date.now();
  try {
    const { muestras, tiempos, fallaron } = await traerTodasLasFuentes(periodo);

    /* El registro de meses cerrados viene del despliegue actual, que es la
       versión commiteada: lo mismo que leía el flujo tras hacer checkout. */
    let registro = registroVacio();
    try { registro = (await leerDato('meses-cerrados.json')) || registro; } catch { /* la primera vez no existe */ }
    let narrativa = {};
    try { narrativa = (await leerDato('narrativa.json')) || {}; } catch { /* es opcional */ }

    const r = construir({ muestras, tiempos, fallaron, narrativa, registro,
                          msTotal: Date.now() - t0 });

    if (r.fugas.length) {
      return res.status(500).json({ ok: false, error: 'fuga_vista_equipo',
        mensaje: 'La vista de Equipo dejaría escapar datos que no debe. No se publicó nada.',
        fugas: r.fugas });
    }

    const archivos = {
      'data/corte.json': JSON.stringify(r.corte, null, 2),
      'data/meses-cerrados.json': JSON.stringify(r.registro, null, 2),
    };

    if (devolver || ensayo) {
      return res.status(200).json({ ok: true, ensayo: true, periodo,
        corte: r.corte.corte,
        resumen: resumir({ ...r, fallaron }), sin_respuesta: Object.keys(fallaron),
        bytes: Object.fromEntries(Object.entries(archivos).map(([k, v]) => [k, v.length])),
        ...(devolver ? { archivos } : {}) });
    }

    const pub = await publicarArchivos({
      repo: REPO, token: process.env.GITHUB_TOKEN, rama: RAMA, archivos,
      mensaje: `Corte automático ${r.corte.corte}`,
    });

    return res.status(200).json({ ok: true, periodo, corte: r.corte.corte,
      publicado: pub.cambios, commit: pub.commit,
      resumen: resumir({ ...r, fallaron }),
      sin_respuesta: Object.keys(fallaron),
      ms: Date.now() - t0 });
  } catch (e) {
    console.error('[publicar] falló:', e);
    return res.status(500).json({ ok: false, error: 'fallo',
      mensaje: String(e && e.message || e), ms: Date.now() - t0 });
  }
}
