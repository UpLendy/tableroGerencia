/* ---------------------------------------------------------------------------
 * mcp.mjs — el protocolo MCP, sin red y sin Vercel.
 *
 * Todo lo que decide qué contestar vive aquí y es una función pura: se le dan
 * la petición y el corte, y devuelve el cuerpo y el código HTTP. Así se puede
 * probar entero sin levantar nada, que es lo único que hace manejable un
 * protocolo con tantas reglas de «MUST».
 *
 * Contra la revisión 2026-07-28, que cambió bastante respecto a lo que
 * mucha documentación de segunda mano todavía describe:
 *
 *   · No hay initialize. El saludo es server/discover y los servidores MUST
 *     implementarlo.
 *   · No hay sesiones. Se quitaron del protocolo.
 *   · No hace falta SSE: a una petición se le puede responder con JSON
 *     plano, y es lo que hacemos porque no mandamos avisos de progreso.
 *   · Hay tres cabeceras obligatorias —MCP-Protocol-Version, Mcp-Method y,
 *     en tools/call, Mcp-Name— y el servidor MUST comprobar que coinciden
 *     con el cuerpo. Si no, 400 y -32020.
 *   · El servidor MUST validar Origin y devolver 403 si viene y no vale.
 * ------------------------------------------------------------------------- */

export const VERSION = '2026-07-28';
/* La revision anterior sigue viva: el conector de Claude habla esa, con
   initialize, sin Mcp-Method y sin la version dentro de _meta. Soportar las
   dos no es cortesia, es la diferencia entre que conecte y que no. */
export const VERSION_ANTERIOR = '2025-11-25';
export const VERSIONES = [VERSION, VERSION_ANTERIOR];
export const SERVIDOR = { name: 'tablero-gerencial-bpm', version: '1.0.0' };

/* Lo que el modelo del otro lado lee antes de llamar a nada. */
export const INSTRUCCIONES =
        'Datos de gestión de BPM Consulting SAS BIC, leídos de su plataforma de formación, ' +
        'de Siigo y de Trello. Cada herramienta devuelve texto ya redactado con las ' +
        'advertencias que le corresponden a cada cifra: un mes en curso va a medias y no se ' +
        'compara contra uno cerrado, la cartera es bruta y no la neta de contabilidad, y lo ' +
        'que se declara como un piso no es un total. Repite esas advertencias al dar la cifra ' +
        'y no las omitas por brevedad. Si un dato no está en lo que devuelve una herramienta, ' +
        'dilo en vez de estimarlo.';

/* Códigos del propio protocolo, no inventados. */
export const ERR = {
  parse: -32700, peticion: -32600, metodo: -32601, parametros: -32602,
  cabecera: -32020, version: -32022,
};

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) },
});

const metaDe = (cuerpo) => (cuerpo && cuerpo.params && cuerpo.params._meta) || {};
const cab = (h, n) => {
  if (!h) return undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === n.toLowerCase());
  return k === undefined ? undefined : h[k];
};

/**
 * Decide la respuesta. Devuelve { estado, cuerpo } y nada más: no escribe,
 * no lee ficheros, no sabe que existe Vercel.
 *
 *   @param cuerpo    el JSON-RPC ya parseado
 *   @param cabeceras las cabeceras de la petición
 *   @param ctx       { herramientas, autorizado, origenValido }
 */
/** Que dialecto habla quien llama. Lo decide lo que manda, no lo que dice. */
export function dialecto(cuerpo, cabeceras = {}) {
  const v = cab(cabeceras, 'MCP-Protocol-Version');
  if (v === VERSION) return VERSION;
  if (v === VERSION_ANTERIOR) return VERSION_ANTERIOR;
  if (cuerpo && cuerpo.method === 'initialize') return VERSION_ANTERIOR;
  if (!cab(cabeceras, 'Mcp-Method')) return VERSION_ANTERIOR;
  return VERSION;
}

export function responder(cuerpo, cabeceras = {}, ctx = {}) {
  const { herramientas = {}, autorizado = false, origenValido = true } = ctx;

  /* Origen primero: el protocolo lo pide contra el ataque de reenlace de DNS,
     y no tiene sentido mirar nada más de una petición que no debería llegar. */
  if (!origenValido) {
    return { estado: 403, cuerpo: rpcError(null, ERR.peticion, 'Origen no permitido') };
  }
  if (!autorizado) {
    return { estado: 401, cuerpo: rpcError(null, ERR.peticion, 'Falta el token del tablero o no es válido') };
  }
  if (!cuerpo || typeof cuerpo !== 'object' || cuerpo.jsonrpc !== '2.0' || typeof cuerpo.method !== 'string') {
    return { estado: 400, cuerpo: rpcError(cuerpo && cuerpo.id, ERR.peticion, 'La petición no es JSON-RPC 2.0') };
  }

  const id = cuerpo.id;
  const meta = metaDe(cuerpo);
  const esAviso = id === undefined;
  const moderno = dialecto(cuerpo, cabeceras) === VERSION;

  /* La versión va en dos sitios y MUST coincidir. Que coincida no es una
     formalidad: si la cabecera dice una cosa y el cuerpo otra, hay algo en
     medio reescribiendo peticiones y eso es justo lo que no se quiere. */
  if (!moderno) {
    /* En la revision anterior no existen Mcp-Method, Mcp-Name ni la version
       dentro de _meta. Exigirlas alli seria rechazar a un cliente que esta
       hablando correctamente su propio idioma. */
    return responderAntiguo(cuerpo, id, esAviso, herramientas);
  }
  const vCab = cab(cabeceras, 'MCP-Protocol-Version');
  const vCuerpo = meta['io.modelcontextprotocol/protocolVersion'];
  if (!vCab || !vCuerpo) {
    return { estado: 400, cuerpo: rpcError(id, ERR.cabecera,
      'Falta la versión del protocolo: va en la cabecera MCP-Protocol-Version y en _meta') };
  }
  if (vCab !== vCuerpo) {
    return { estado: 400, cuerpo: rpcError(id, ERR.cabecera,
      `La cabecera dice ${vCab} y el cuerpo ${vCuerpo}`) };
  }
  if (!VERSIONES.includes(vCuerpo)) {
    return { estado: 400, cuerpo: rpcError(id, ERR.version,
      `Versión no soportada: ${vCuerpo}`, { supported: VERSIONES }) };
  }

  const mCab = cab(cabeceras, 'Mcp-Method');
  if (!mCab) return { estado: 400, cuerpo: rpcError(id, ERR.cabecera, 'Falta la cabecera Mcp-Method') };
  if (mCab !== cuerpo.method) {
    return { estado: 400, cuerpo: rpcError(id, ERR.cabecera,
      `La cabecera Mcp-Method dice ${mCab} y el cuerpo llama a ${cuerpo.method}`) };
  }

  /* ---------------------------------------------------------- discover */
  if (cuerpo.method === 'server/discover') {
    return { estado: 200, cuerpo: { jsonrpc: '2.0', id, result: {
      resultType: 'complete',
      supportedVersions: VERSIONES,
      capabilities: { tools: {} },
      instructions: INSTRUCCIONES,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVIDOR },
      ttlMs: 3600000, cacheScope: 'public',
    } } };
  }

  /* ------------------------------------------------------- tools/list */
  if (cuerpo.method === 'tools/list') {
    return { estado: 200, cuerpo: { jsonrpc: '2.0', id, result: {
      resultType: 'complete',
      tools: Object.values(herramientas).map((h) => ({
        name: h.name, title: h.title, description: h.description,
        inputSchema: h.inputSchema || { type: 'object', additionalProperties: false },
      })),
    } } };
  }

  /* ------------------------------------------------------- tools/call */
  if (cuerpo.method === 'tools/call') {
    const nombre = cuerpo.params && cuerpo.params.name;
    const nCab = cab(cabeceras, 'Mcp-Name');
    if (!nCab) return { estado: 400, cuerpo: rpcError(id, ERR.cabecera, 'Falta la cabecera Mcp-Name') };
    if (nCab !== nombre) {
      return { estado: 400, cuerpo: rpcError(id, ERR.cabecera,
        `La cabecera Mcp-Name dice ${nCab} y el cuerpo pide ${nombre}`) };
    }
    const h = herramientas[nombre];
    /* Herramienta que no existe: error del protocolo. Herramienta que existe
       y falla: resultado normal con isError. No es lo mismo y el cliente las
       trata distinto. */
    if (!h) return { estado: 200, cuerpo: rpcError(id, ERR.parametros, `No existe la herramienta ${nombre}`) };
    /* Hasta aquí llega esta función: decide, no ejecuta. Devuelve a quién hay
       que llamar y con qué, y quien tenga los datos delante lo llama. Así
       todo lo de arriba —que son veinte reglas de protocolo— se prueba sin
       necesitar un corte, y la herramienta se prueba sin necesitar una
       petición HTTP bien formada. */
    return { estado: 200, ejecutar: { id, nombre, argumentos: (cuerpo.params && cuerpo.params.arguments) || {} } };
  }

  if (esAviso) return { estado: 202, cuerpo: null };
  return { estado: 404, cuerpo: rpcError(id, ERR.metodo, `Método no implementado: ${cuerpo.method}`) };
}

/* ------------------------------------------------------ revision anterior
   initialize en vez de server/discover, la version como campo suelto, y el
   resultado sin resultType: el cliente de entonces trata su ausencia como
   «completo», que es justo lo que queremos decir. */
function responderAntiguo(cuerpo, id, esAviso, herramientas) {
  if (cuerpo.method === 'initialize') {
    return { estado: 200, cuerpo: { jsonrpc: '2.0', id, result: {
      protocolVersion: VERSION_ANTERIOR,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVIDOR,
      instructions: INSTRUCCIONES,
    } } };
  }
  if (cuerpo.method === 'notifications/initialized' || esAviso) {
    return { estado: 202, cuerpo: null };
  }
  if (cuerpo.method === 'tools/list') {
    return { estado: 200, cuerpo: { jsonrpc: '2.0', id, result: {
      tools: Object.values(herramientas).map((h) => ({
        name: h.name, description: h.description,
        inputSchema: h.inputSchema || { type: 'object', additionalProperties: false },
      })),
    } } };
  }
  if (cuerpo.method === 'tools/call') {
    const nombre = cuerpo.params && cuerpo.params.name;
    if (!herramientas[nombre]) {
      return { estado: 200, cuerpo: rpcError(id, ERR.parametros, `No existe la herramienta ${nombre}`) };
    }
    return { estado: 200, antiguo: true,
      ejecutar: { id, nombre, argumentos: (cuerpo.params && cuerpo.params.arguments) || {} } };
  }
  return { estado: 404, cuerpo: rpcError(id, ERR.metodo, `Metodo no implementado: ${cuerpo.method}`) };
}

/** El resultado de una herramienta, ya con la forma que pide el protocolo. */
export const resultado = (id, texto, mal = false, antiguo = false) => ({
  jsonrpc: '2.0', id,
  result: {
    ...(antiguo ? {} : { resultType: 'complete' }),
    content: [{ type: 'text', text: String(texto) }], isError: mal,
  },
});

/** Comparación de tokens que no se delata por el tiempo que tarda. */
export function tokenValido(dado, esperado) {
  if (!esperado || !dado) return false;
  const a = String(dado), b = String(esperado);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
