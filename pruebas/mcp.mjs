/* Pruebas del protocolo MCP.

   El protocolo 2026-07-28 tiene muchas reglas de «MUST» y casi todas son
   sobre cosas que no deben pasar: cabeceras que no coinciden con el cuerpo,
   versiones que no se soportan, métodos que no existen. Eso es exactamente
   lo que no se descubre probando a mano, porque a mano uno manda peticiones
   bien formadas. Por eso responder() es una función pura y esto no levanta
   nada.

   Y la primera de todas: que sin token no se conteste nada. El tablero lleva
   meses separando lo que ve Dirección de lo que ve el Equipo; un MCP abierto
   seria la puerta de atrás a todo eso. */
import { responder, resultado, tokenValido, dialecto, VERSION, VERSION_ANTERIOR, ERR, SERVIDOR } from '../scripts/mcp.mjs';
import { secciones, HERRAMIENTAS } from '../api/mcp.mjs';
import { fichaDelCorte } from '../api/chat.mjs';
import { adjuntarCartera, adjuntarTrello } from '../scripts/alertas.mjs';
import { readFileSync } from 'node:fs';

let fallos = 0;
const cierto = (v, q) => { console.log((v ? '  ok   ' : '  FALLA ') + q); if (!v) fallos++; };
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); fallos++; }
};

const HERR = {
  corte: { name: 'corte', title: 'El corte', description: 'd' },
  alertas: { name: 'alertas', title: 'Alertas', description: 'd' },
};
const ctx = (extra = {}) => ({ herramientas: HERR, autorizado: true, origenValido: true, ...extra });
const meta = (v = VERSION) => ({
  'io.modelcontextprotocol/protocolVersion': v,
  'io.modelcontextprotocol/clientInfo': { name: 'claude', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});
const pet = (method, params = {}, v = VERSION) =>
  ({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta(v) } });
const cabs = (method, extra = {}) =>
  ({ 'MCP-Protocol-Version': VERSION, 'Mcp-Method': method, ...extra });

console.log('\n-- sin token no se contesta nada --');
{
  const r = responder(pet('server/discover'), cabs('server/discover'), ctx({ autorizado: false }));
  iguales(r.estado, 401, 'un discover sin token: 401');
  cierto(!r.cuerpo.result, 'y no se le devuelve ningún resultado');
  const l = responder(pet('tools/list'), cabs('tools/list'), ctx({ autorizado: false }));
  iguales(l.estado, 401, 'tampoco se le dice qué herramientas hay');
  const c = responder(pet('tools/call', { name: 'corte' }), cabs('tools/call', { 'Mcp-Name': 'corte' }), ctx({ autorizado: false }));
  iguales(c.estado, 401, 'ni se le ejecuta ninguna');
  cierto(!c.ejecutar, 'y sobre todo: no se llega a ejecutar nada');
}

console.log('\n-- el origen se comprueba antes que el token --');
{
  const r = responder(pet('tools/list'), cabs('tools/list'), ctx({ origenValido: false, autorizado: true }));
  iguales(r.estado, 403, 'origen no válido: 403');
}

console.log('\n-- las cabeceras tienen que coincidir con el cuerpo --');
{
  const sinV = responder(pet('tools/list'), { 'Mcp-Method': 'tools/list' }, ctx());
  iguales(sinV.estado, 400, 'sin MCP-Protocol-Version: 400');
  iguales(sinV.cuerpo.error.code, ERR.cabecera, 'con el código de cabecera');

  /* La discrepancia solo tiene sentido dentro del dialecto moderno: en el
     anterior la versión no viaja en el cuerpo, asi que no hay nada que
     comparar. Se prueba al reves que antes: cabecera moderna, cuerpo viejo. */
  const mal = responder(pet('tools/list', {}, VERSION_ANTERIOR), cabs('tools/list'), ctx());
  iguales(mal.estado, 400, 'si la cabecera dice una versión y el cuerpo otra: 400');
  iguales(mal.cuerpo.error.code, ERR.cabecera, 'y es error de cabecera, no de versión');

  const otroM = responder(pet('tools/list'), cabs('server/discover'), ctx());
  iguales(otroM.estado, 400, 'si Mcp-Method no es el método del cuerpo: 400');
  cierto(/tools\/list/.test(otroM.cuerpo.error.message), 'diciendo cuál es cuál');

  const sinM = responder(pet('tools/list'), { 'MCP-Protocol-Version': VERSION }, ctx());
  iguales(sinM.estado, 400, 'sin Mcp-Method: 400');
}

console.log('\n-- una versión que no hablamos --');
{
  const r = responder(pet('tools/list', {}, '2024-01-01'),
    cabs('tools/list', { 'MCP-Protocol-Version': '2024-01-01' }), ctx());
  iguales(r.estado, 400, '400');
  iguales(r.cuerpo.error.code, ERR.version, 'con el código de versión no soportada');
  iguales(r.cuerpo.error.data.supported, [VERSION, VERSION_ANTERIOR],
    'y la lista de las que sí, que es lo que el cliente necesita');
}

console.log('\n-- el dialecto anterior, que es el que habla el conector --');
{
  /* Registrado de un intento real: initialize, version 2025-11-25 en la
     cabecera, nada de Mcp-Method, y la version ausente del cuerpo. El
     servidor estricto lo rechazaba y desde fuera se veia como «no se pudo
     conectar», que es el peor mensaje posible porque culpa al sitio
     equivocado. */
  const viejas = { 'MCP-Protocol-Version': VERSION_ANTERIOR };
  iguales(dialecto({ method: 'initialize' }, {}), VERSION_ANTERIOR,
    'un initialize es del dialecto anterior, diga lo que diga la cabecera');
  iguales(dialecto({ method: 'tools/list' }, {}), VERSION_ANTERIOR,
    'y sin Mcp-Method tampoco puede ser el moderno');
  iguales(dialecto({ method: 'tools/list' }, cabs('tools/list')), VERSION,
    'con su cabecera completa, moderno');

  const ini = responder({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, viejas, ctx());
  iguales(ini.estado, 200, 'initialize contesta 200');
  iguales(ini.cuerpo.result.protocolVersion, VERSION_ANTERIOR,
    'con la versión como campo suelto, que es como era entonces');
  iguales(ini.cuerpo.result.serverInfo, SERVIDOR, 'y serverInfo arriba, no dentro de _meta');
  cierto(/piso no es un total/.test(ini.cuerpo.result.instructions),
    'con las mismas instrucciones que el saludo moderno, no otras');

  const av = responder({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, viejas, ctx());
  iguales(av.estado, 202, 'el aviso de que ya está iniciado: 202 y sin cuerpo');

  const l = responder({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, viejas, ctx());
  iguales(l.cuerpo.result.tools.map((t) => t.name), ['corte', 'alertas'], 'lista las herramientas');
  cierto(!('resultType' in l.cuerpo.result),
    'sin resultType, que en esa revisión no existía');

  const c = responder({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'corte', arguments: {} } }, viejas, ctx());
  iguales(c.ejecutar, { id: 3, nombre: 'corte', argumentos: {} }, 'y llama a la herramienta');
  cierto(c.antiguo === true, 'marcando que la respuesta va en el dialecto anterior');

  const r = resultado(3, 'texto', false, true);
  cierto(!('resultType' in r.result), 'cuyo resultado tampoco lleva resultType');
  iguales(r.result.content, [{ type: 'text', text: 'texto' }], 'pero sí el contenido igual');

  /* Y lo que no se relaja: sin token no se contesta en ningún dialecto. */
  const sin = responder({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    viejas, ctx({ autorizado: false }));
  iguales(sin.estado, 401, 'el dialecto anterior no es una puerta sin llave');
}

console.log('\n-- el saludo, que ya no es initialize --');
{
  const r = responder(pet('server/discover'), cabs('server/discover'), ctx());
  iguales(r.estado, 200, '200');
  iguales(r.cuerpo.result.resultType, 'complete', 'con resultType, que esta versión exige');
  iguales(r.cuerpo.result.supportedVersions, [VERSION, VERSION_ANTERIOR],
    'las versiones van en un array, y estan las dos que hablamos');
  cierto(r.cuerpo.result.capabilities && r.cuerpo.result.capabilities.tools, 'declara que tiene herramientas');
  iguales(r.cuerpo.result._meta['io.modelcontextprotocol/serverInfo'], SERVIDOR,
    'y quién es el servidor, que va dentro de _meta y no arriba');
  cierto(/piso no es un total/.test(r.cuerpo.result.instructions),
    'las instrucciones le dicen al modelo que repita las advertencias de cada cifra');
}

console.log('\n-- listar y llamar --');
{
  const l = responder(pet('tools/list'), cabs('tools/list'), ctx());
  iguales(l.cuerpo.result.tools.map((t) => t.name), ['corte', 'alertas'], 'lista las herramientas');
  cierto(l.cuerpo.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'),
    'cada una con su inputSchema, que MUST ser un objeto y no null');

  const c = responder(pet('tools/call', { name: 'corte', arguments: { mes: '2026-10' } }),
    cabs('tools/call', { 'Mcp-Name': 'corte' }), ctx());
  iguales(c.ejecutar, { id: 1, nombre: 'corte', argumentos: { mes: '2026-10' } },
    'una llamada válida devuelve a quién llamar y con qué');
  cierto(!c.cuerpo, 'y no inventa un resultado: eso lo pone quien tenga los datos');

  const sinN = responder(pet('tools/call', { name: 'corte' }), cabs('tools/call'), ctx());
  iguales(sinN.estado, 400, 'sin la cabecera Mcp-Name: 400');
  const otroN = responder(pet('tools/call', { name: 'corte' }), cabs('tools/call', { 'Mcp-Name': 'alertas' }), ctx());
  iguales(otroN.estado, 400, 'y si Mcp-Name no es la herramienta del cuerpo, también');
}

console.log('\n-- lo que no existe --');
{
  const h = responder(pet('tools/call', { name: 'inventada' }),
    cabs('tools/call', { 'Mcp-Name': 'inventada' }), ctx());
  iguales(h.estado, 200, 'una herramienta que no existe se contesta con 200');
  iguales(h.cuerpo.error.code, ERR.parametros, 'y error -32602, que es lo que dice la norma');

  const m = responder(pet('resources/read'), cabs('resources/read'), ctx());
  iguales(m.estado, 404, 'un método que no implementamos: 404');
  iguales(m.cuerpo.error.code, ERR.metodo, 'con -32601');
}

console.log('\n-- un aviso no lleva respuesta --');
{
  const a = { jsonrpc: '2.0', method: 'notifications/algo', params: { _meta: meta() } };
  const r = responder(a, cabs('notifications/algo'), ctx());
  iguales(r.estado, 202, '202');
  iguales(r.cuerpo, null, 'y sin cuerpo');
}

console.log('\n-- la forma de un resultado --');
{
  const r = resultado(7, 'el texto', false);
  iguales(r.result.resultType, 'complete', 'lleva resultType');
  iguales(r.result.content, [{ type: 'text', text: 'el texto' }], 'el texto va en content, como bloque de tipo text');
  iguales(r.result.isError, false, 'y dice si fue error');
  iguales(resultado(7, 'se rompió', true).result.isError, true,
    'una herramienta que falla NO es un error de protocolo: es un resultado con isError');
}

console.log('\n-- el token se compara sin delatarse --');
{
  cierto(tokenValido('abc', 'abc'), 'igual, vale');
  cierto(!tokenValido('abc', 'abd'), 'distinto, no');
  cierto(!tokenValido('ab', 'abc'), 'de otra longitud, tampoco');
  cierto(!tokenValido('', 'abc'), 'vacío, no');
  cierto(!tokenValido('abc', ''), 'y si no hay token configurado, no vale ninguno');
  cierto(!tokenValido('abc', undefined), 'ni aunque el esperado no exista');
}

console.log('\n-- partir la ficha en secciones --');
{
  /* Las herramientas no redactan: toman trozos de la ficha, que es donde
     viven las advertencias de cada cifra. Si un titulo cambia, la
     herramienta devolveria menos de lo que cree, y en silencio. Esto lo
     caza. */
  const s = secciones('cabecera suelta\n## Uno\nlinea a\nlinea b\n## Dos\nlinea c');
  iguales([...s.keys()], ['(cabecera)', 'Uno', 'Dos'], 'parte por los títulos de nivel dos');
  iguales(s.get('Uno'), 'linea a\nlinea b', 'y conserva el cuerpo de cada una');
  iguales(s.get('(cabecera)'), 'cabecera suelta', 'lo de antes del primer título no se pierde');

  /* Y que la ficha real siga teniendo las secciones de las que tiran las
     herramientas. Con un corte minimo, que no haga falta data/. */
  const corte = {
    corte: '2026-11-24', regla: 'r', origen: 'vivo',
    meses: [
      { id: '2026-10', lbl: 'Octubre 2026', cert: 1848, personas: 1800, canal: { emp: 1800, par: 48 },
        ingreso: 1e6, ingresoBPM: null, activas: 57, registradas: 79 },
      { id: '2026-11', lbl: 'Noviembre 2026', cert: 900, personas: 880, canal: { emp: 880, par: 20 },
        ingreso: 5e5, ingresoBPM: null, activas: 40, registradas: 79 },
    ],
    empresas: [], serie: [{ periodo: '2026-10', certificados: 1848, personas: 1800, empresas_activas: 57 }],
  };
  const reales = [...secciones(fichaDelCorte(corte)).keys()];
  const necesarias = ['Meses del corte', 'CÓMO COMPARAR', 'Serie mensual'];
  necesarias.forEach((n) => cierto(reales.some((x) => x.startsWith(n)),
    `la ficha sigue trayendo la sección «${n}», de la que tira corte_del_mes`));
}

console.log('\n-- ninguna herramienta devuelve vacío en silencio --');
{
  /* Las herramientas no redactan: recortan la ficha por sus títulos. Si
     alguien renombra un título —cosa que ya pasó dos veces en este
     proyecto— la herramienta seguiría respondiendo, pero con nada dentro,
     y el modelo del otro lado diría que no tiene el dato. Un fallo mudo.
     Esto lo convierte en una prueba roja. */
  const leer = (f) => { try { return JSON.parse(readFileSync('data/' + f, 'utf8')); } catch { return null; } };
  const corte = leer('corte.json');
  if (!corte) {
    console.log('  (sin data/corte.json: esta comprobación necesita datos publicados)');
  } else {
    adjuntarCartera(corte, leer('cartera.json'), leer('conciliacion.json'));
    adjuntarTrello(corte, leer('trello.json'));
    for (const h of Object.values(HERRAMIENTAS)) {
      const texto = String(h.correr(corte) || '');
      cierto(texto.trim().length > 40,
        `«${h.name}» devuelve algo (${texto.length.toLocaleString('es-CO')} caracteres)`);
    }
    /* Y que cada una devuelva lo SUYO, no la ficha entera por accidente. */
    const todo = fichaDelCorte(corte).length;
    cierto(Object.values(HERRAMIENTAS).every((h) => String(h.correr(corte)).length < todo * 0.6),
      'y ninguna devuelve la ficha entera, que sería no haber recortado nada');
  }
}

console.log('\n-- las herramientas se describen para que el modelo elija bien --');
{
  for (const h of Object.values(HERRAMIENTAS)) {
    cierto(h.name && h.title && h.description && h.inputSchema,
      `«${h.name}» tiene nombre, título, descripción y esquema`);
    cierto(/^[A-Za-z0-9_.-]{1,128}$/.test(h.name),
      `y su nombre respeta el formato que pide la norma`);
  }
  cierto(HERRAMIENTAS.cuentas_por_cobrar.description.includes('BRUTA'),
    'la de cartera avisa en su propia descripción de que es bruta y no la neta');
  cierto(/no es una tasa/.test(HERRAMIENTAS.vencimientos.description),
    'y la de renovación, de que una cohorte abierta no da una tasa');
}

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo en orden\n');
process.exit(fallos ? 1 : 0);
