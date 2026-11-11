/* ---------------------------------------------------------------------------
 * sesion.mjs — quién está pidiendo el corte.
 *
 * El tablero separa Gerencia de Equipo, y esa separación no puede depender de
 * un parámetro de la URL: borrarlo seria todo lo que haria falta. Aquí el rol
 * viaja en una cookie firmada por el servidor, de modo que el navegador puede
 * guardarla pero no fabricarla ni modificarla.
 *
 * La firma es HMAC-SHA256 sobre "rol.vencimiento" con un secreto que vive solo
 * en el entorno del proyecto. Cambiar el secreto invalida todas las sesiones,
 * que es justo lo que se quiere el día que una clave se filtre.
 *
 * No se usa JWT a propósito: haría falta una dependencia para algo que son
 * veinte líneas, y las partes de un JWT que aquí no se usan son precisamente
 * las que suelen implementarse mal.
 * ------------------------------------------------------------------------- */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const COOKIE = 'tablero_sesion';
/* desarrollo ve los mismos datos que gerencia, a propósito: lo que se
   verifica son las cifras reales. Lo que gana no es menos exposición sino una
   credencial separada, revocable por su cuenta y distinguible en los
   registros, para que quien entra a revisar no use la de la Dirección. Si
   CLAVE_DESARROLLO no está configurada, el rol sencillamente no existe. */
export const ROLES = ['gerencia', 'equipo', 'desarrollo'];

/** Qué datos le corresponden a cada rol. */
export const veTodo = (rol) => rol === 'gerencia' || rol === 'desarrollo';

/** Doce horas: una jornada. Al día siguiente hay que volver a entrar. */
const VIGENCIA_MS = 12 * 60 * 60 * 1000;

const secreto = () => process.env.SESION_SECRETO || '';

const base64url = (b) => Buffer.from(b).toString('base64url');

function firmaDe(carga) {
  return createHmac('sha256', secreto()).update(carga).digest('base64url');
}

/**
 * Comparación de tiempo constante. Con `===` el tiempo de respuesta depende de
 * cuántos caracteres coinciden, y eso deja adivinar una firma byte a byte.
 */
export function igualesSeguro(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  /* timingSafeEqual exige la misma longitud, y la longitud misma se puede
     observar. Se comparan hashes, que siempre miden lo mismo. */
  const ha = createHmac('sha256', 'comparacion').update(A).digest();
  const hb = createHmac('sha256', 'comparacion').update(B).digest();
  return timingSafeEqual(ha, hb);
}

/** Token para un rol. Devuelve null si falta el secreto del entorno. */
export function firmar(rol) {
  if (!secreto() || !ROLES.includes(rol)) return null;
  const vence = Date.now() + VIGENCIA_MS;
  const carga = `${rol}.${vence}`;
  return `${base64url(carga)}.${firmaDe(carga)}`;
}

/** Rol del token, o null si no es válido, fue alterado o ya venció. */
export function verificar(token) {
  if (!secreto() || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;

  let carga;
  try {
    carga = Buffer.from(partes[0], 'base64url').toString('utf8');
  } catch { return null; }

  if (!igualesSeguro(partes[1], firmaDe(carga))) return null;

  const [rol, vence] = carga.split('.');
  if (!ROLES.includes(rol)) return null;
  if (!Number(vence) || Number(vence) < Date.now()) return null;
  return rol;
}

/** Lee la cookie de la petición. */
export function rolDe(req) {
  const crudo = req?.headers?.cookie || '';
  for (const parte of crudo.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE) return verificar(decodeURIComponent(v.join('=')));
  }
  return null;
}

/**
 * Cabecera Set-Cookie. httpOnly para que el JavaScript de la página no pueda
 * leerla —ni el nuestro ni el de nadie—, Secure para que no viaje en claro, y
 * SameSite=Lax para que otro sitio no la pueda usar en nuestro nombre.
 */
export function cookieDeSesion(token) {
  const partes = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.floor(VIGENCIA_MS / 1000)}`,
  ];
  return partes.join('; ');
}

export const cookieDeSalida = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** Para el mensaje de arranque: qué falta configurar. */
export function faltaConfiguracion() {
  const faltan = [];
  if (!process.env.SESION_SECRETO) faltan.push('SESION_SECRETO');
  if (!process.env.CLAVE_GERENCIA) faltan.push('CLAVE_GERENCIA');
  if (!process.env.CLAVE_EQUIPO) faltan.push('CLAVE_EQUIPO');
  /* CLAVE_DESARROLLO no se exige: es opcional y se borra al terminar. */
  return faltan;
}

/** Un secreto nuevo, para cuando haya que generarlo. */
export const secretoNuevo = () => randomBytes(32).toString('base64url');
