/* ---------------------------------------------------------------------------
 * /api/entrar — la puerta.
 *
 *   GET     dice si hay sesión y con qué rol. La página lo consulta al cargar.
 *   POST    recibe una clave, la compara y entrega la cookie firmada.
 *   DELETE  cierra la sesión.
 *
 * Dos claves, una por rol, guardadas como variables de entorno del proyecto.
 * Quien tiene la de Gerencia ve dinero y nombres; quien tiene la de Equipo ve
 * semáforos. La clave nunca se devuelve ni se registra en ningún log.
 *
 * El freno por IP no es decorativo: sin él, una clave corta se adivina sola.
 * Con seis intentos por minuto y veinte por hora, probar un diccionario deja
 * de ser viable mucho antes de llegar a ninguna parte.
 * ------------------------------------------------------------------------- */
import {
  firmar, rolDe, igualesSeguro, cookieDeSesion, cookieDeSalida, faltaConfiguracion,
} from '../scripts/sesion.mjs';

const LIM = { porMinuto: 6, porHora: 20, claveMax: 200 };

/* En memoria y por instancia, igual que el del chat: es un freno, no un
   candado. Para un candado hace falta un almacén compartido, y está dicho. */
const intentos = new Map();

function dejaIntentar(ip) {
  const ahora = Date.now();
  const reg = (intentos.get(ip) || []).filter((t) => ahora - t < 3600_000);

  if (reg.filter((t) => ahora - t < 60_000).length >= LIM.porMinuto)
    return { ok: false, espera: 60 };
  if (reg.length >= LIM.porHora) return { ok: false, espera: 3600 };

  reg.push(ahora);
  intentos.set(ip, reg);
  if (intentos.size > 5000) {
    for (const [k, v] of intentos) if (!v.some((t) => ahora - t < 3600_000)) intentos.delete(k);
  }
  return { ok: true };
}

const ipDe = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.headers['x-real-ip'] || 'desconocida';

export default async function handler(req, res) {
  const faltan = faltaConfiguracion();

  /* ------------------------------------------------------------------ GET */
  if (req.method === 'GET') {
    if (faltan.length) {
      /* Sin configurar, la página tiene que poder decirlo con claridad en vez
         de dejar al usuario frente a una clave que no va a funcionar nunca. */
      console.error('[entrar] faltan variables:', faltan.join(', '));
      return res.status(503).json({ ok: false, error: 'sin_configurar' });
    }
    return res.status(200).json({ ok: true, rol: rolDe(req) });
  }

  /* --------------------------------------------------------------- DELETE */
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', cookieDeSalida());
    return res.status(200).json({ ok: true, rol: null });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
  }

  /* ----------------------------------------------------------------- POST */
  if (faltan.length) {
    console.error('[entrar] faltan variables:', faltan.join(', '));
    return res.status(503).json({ ok: false, error: 'sin_configurar' });
  }

  const freno = dejaIntentar(ipDe(req));
  if (!freno.ok) {
    res.setHeader('Retry-After', String(freno.espera));
    return res.status(429).json({
      ok: false,
      error: 'demasiados_intentos',
      mensaje: 'Demasiados intentos. Espera un momento antes de volver a probar.',
    });
  }

  const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const clave = String(cuerpo.clave || '').slice(0, LIM.claveMax);
  if (!clave) return res.status(400).json({ ok: false, error: 'sin_clave' });

  /* Se comparan las dos siempre, sin cortar en la primera que acierte: así el
     tiempo de respuesta no delata cuál de los dos roles coincidió. */
  const esGerencia = igualesSeguro(clave, process.env.CLAVE_GERENCIA);
  const esEquipo = igualesSeguro(clave, process.env.CLAVE_EQUIPO);
  /* Solo cuenta si está configurada: sin la variable, comparar contra vacío
     dejaría entrar a cualquiera con la cadena vacía. */
  const esDesarrollo = !!process.env.CLAVE_DESARROLLO &&
    igualesSeguro(clave, process.env.CLAVE_DESARROLLO);

  const rol = esGerencia ? 'gerencia'
            : esDesarrollo ? 'desarrollo'
            : esEquipo ? 'equipo' : null;

  if (rol === 'desarrollo') console.log('[entrar] sesión de desarrollo');

  if (!rol) {
    /* Un único mensaje para cualquier fallo: decir "esa clave es de Equipo,
       no de Gerencia" sería confirmarle a quien prueba que acertó una. */
    return res.status(401).json({ ok: false, error: 'clave_incorrecta' });
  }

  const token = firmar(rol);
  if (!token) return res.status(500).json({ ok: false, error: 'sin_configurar' });

  res.setHeader('Set-Cookie', cookieDeSesion(token));
  return res.status(200).json({ ok: true, rol });
}
