/* ---------------------------------------------------------------------------
 * siigo.mjs — hablar con Siigo, de solo lectura.
 *
 * Es la cuarta fuente del tablero, después de formación, trámites y
 * Alimentia, y la única que es contabilidad: lo que aquí se lea sale en
 * cifras que BPM usa para cobrar. Por eso este módulo es más estricto que
 * los otros tres.
 *
 * SOLO LECTURA, y no por disciplina sino por construcción: pedir() emite
 * GET y no acepta otro método. La única petición que no es GET en todo el
 * módulo es la de autenticación, que está escrita aparte y a la vista. La
 * cotización excluye escribir en Siigo en dos lugares; esto lo hace difícil
 * de incumplir por accidente.
 *
 * Tres cosas que se aprendieron probando contra la cuenta real y que
 * conviene no volver a descubrir:
 *
 *   · El token dura 24 horas. Pedir uno por llamada desperdicia la mitad
 *     del cupo, así que se reutiliza mientras valga.
 *   · El límite es de 100 peticiones por minuto en una empresa real y 10 en
 *     la de pruebas. La documentación recomienda retirada exponencial ante
 *     el error requests_limit, y con 10 por minuto eso no es teórico.
 *   · Siigo pide esperar al menos 120 segundos antes de cortar una
 *     conexión, así que el tiempo de espera es generoso a propósito.
 *
 * Las credenciales van en el entorno y nunca en el código ni en el
 * repositorio, igual que los tres tokens que ya maneja el tablero.
 * ------------------------------------------------------------------------- */

export const REGLA = 'siigo-v1';

const BASE = process.env.SIIGO_API_BASE || 'https://api.siigo.com';

/** El NIT genérico de consumidor final. No es una empresa: es el canal
 *  particular entero bajo un solo tercero, y por eso sus cantidades no son
 *  certificaciones sino ventas agregadas. */
export const CONSUMIDOR_FINAL = '222222222';

/** Reintentos ante cupo agotado, con la espera doblándose cada vez. */
const REINTENTOS = 4;
const ESPERA_BASE_MS = 2000;
const TIEMPO_MAX_MS = 130000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function faltaConfiguracion() {
  const faltan = [];
  if (!process.env.SIIGO_USERNAME) faltan.push('SIIGO_USERNAME');
  if (!process.env.SIIGO_ACCESS_KEY) faltan.push('SIIGO_ACCESS_KEY');
  if (!process.env.SIIGO_PARTNER_ID) faltan.push('SIIGO_PARTNER_ID');
  return faltan;
}

/**
 * Un cliente con el token ya resuelto. Se crea uno por corrida.
 * No guarda nada en disco y no imprime las credenciales en ningún caso.
 */
export async function crearCliente() {
  const faltan = faltaConfiguracion();
  if (faltan.length) {
    throw new Error('Siigo: faltan variables de entorno · ' + faltan.join(', '));
  }

  const socio = process.env.SIIGO_PARTNER_ID;
  let token = null;
  let vence = 0;

  async function autenticar() {
    /* La única petición que no es GET en todo el módulo. */
    const res = await fetch(new URL('/auth', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Partner-Id': socio },
      body: JSON.stringify({
        username: process.env.SIIGO_USERNAME,
        access_key: process.env.SIIGO_ACCESS_KEY,
      }),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS),
    });
    const texto = await res.text();
    if (!res.ok) {
      /* El cuerpo del error de Siigo no trae credenciales, pero se recorta
         igual: un log que crece sin control es un log que nadie lee. */
      throw new Error(`Siigo /auth: HTTP ${res.status} · ${texto.slice(0, 300)}`);
    }
    const j = JSON.parse(texto);
    if (!j.access_token) throw new Error('Siigo /auth: la respuesta no trae access_token');
    token = j.access_token;
    /* Un minuto de margen: si el token vence a mitad de la paginación, la
       corrida se cae por un segundo de diferencia de reloj. */
    vence = Date.now() + (Number(j.expires_in || 86400) - 60) * 1000;
    return j;
  }

  const datosAuth = await autenticar();

  async function pedir(ruta, params = {}, intento = 0) {
    if (!token || Date.now() >= vence) await autenticar();

    const url = new URL(ruta, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let res;
    try {
      res = await fetch(url, {
        /* GET fijo. No hay forma de que este módulo escriba en la
           contabilidad del cliente por un parámetro mal puesto. */
        method: 'GET',
        headers: { Accept: 'application/json', 'Partner-Id': socio, Authorization: token },
        signal: AbortSignal.timeout(TIEMPO_MAX_MS),
      });
    } catch (e) {
      throw new Error(`Siigo ${ruta}: no respondió · ${e.message}`);
    }

    const texto = await res.text();

    if (!res.ok) {
      const cupo = res.status === 429 || /requests_limit/i.test(texto);
      const caido = res.status >= 500 || /service_unavailable|request_timeout/i.test(texto);
      if ((cupo || caido) && intento < REINTENTOS) {
        await dormir(ESPERA_BASE_MS * 2 ** intento);
        return pedir(ruta, params, intento + 1);
      }
      /* unauthorized puede ser token vencido O usuario bloqueado del lado de
         Siigo. No es lo mismo y reintentar no arregla lo segundo, así que se
         distingue en el mensaje para que quien lea el log no pierda el rato. */
      if (res.status === 401 && intento < 1) {
        token = null;
        return pedir(ruta, params, intento + 1);
      }
      if (res.status === 401) {
        throw new Error('Siigo ' + ruta + ': no autorizado después de renovar el token. ' +
          'Puede ser que el usuario de API esté bloqueado del lado de Siigo.');
      }
      throw new Error(`Siigo ${ruta}: HTTP ${res.status} · ${texto.slice(0, 300)}`);
    }

    try { return JSON.parse(texto); }
    catch { throw new Error(`Siigo ${ruta}: la respuesta no es JSON · ${texto.slice(0, 200)}`); }
  }

  /** Recorre todas las páginas de un listado. */
  async function paginar(ruta, params = {}, tope = 200) {
    const todo = [];
    let pagina = 1, total = null;
    do {
      const r = await pedir(ruta, { ...params, page: pagina, page_size: 100 });
      total = Number(r?.pagination?.total_results ?? 0);
      const lote = r?.results || [];
      todo.push(...lote);
      if (!lote.length) break;
      pagina++;
    } while (todo.length < total && pagina <= tope);
    return todo;
  }

  return {
    regla: REGLA,
    duracionToken: Number(datosAuth.expires_in || 0),

    /** Facturas de venta del periodo, sin las anuladas. */
    async facturas(desde, hasta) {
      const todas = await paginar('/v1/invoices', { date_start: desde, date_end: hasta });
      /* Una factura anulada que se cuente infla el mes. El campo existe y se
         usa; no se descubre después cuando el cruce no cuadre. */
      return { todas, vigentes: todas.filter((f) => f.annulled !== true) };
    },

    /** Notas crédito del periodo. Sin ellas lo facturado queda inflado. */
    async notasCredito(desde, hasta) {
      try { return await paginar('/v1/credit-notes', { date_start: desde, date_end: hasta }); }
      catch (e) { return { error: e.message }; }
    },

    /** El maestro de terceros: NIT → nombre. */
    async terceros() {
      const lista = await paginar('/v1/customers', {});
      const mapa = new Map();
      for (const c of lista) {
        const nombre = Array.isArray(c.name) ? c.name.filter(Boolean).join(' ') : String(c.name || '');
        mapa.set(String(c.identification || '').replace(/\D/g, ''),
                 (c.commercial_name || nombre || '').trim());
      }
      return mapa;
    },
  };
}
