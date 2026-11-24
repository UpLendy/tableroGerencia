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
import { responder, resultado, tokenValido, VERSION, ERR, SERVIDOR } from '../scripts/mcp.mjs';
import { secciones } from '../api/mcp.mjs';
import { fichaDelCorte } from '../api/chat.mjs';

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

  const mal = responder(pet('tools/list'), cabs('tools/list', { 'MCP-Protocol-Version': '2025-11-25' }), ctx());
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
  const r = responder(pet('tools/list', {}, '2025-11-25'),
    cabs('tools/list', { 'MCP-Protocol-Version': '2025-11-25' }), ctx());
  iguales(r.estado, 400, '400');
  iguales(r.cuerpo.error.code, ERR.version, 'con el código de versión no soportada');
  iguales(r.cuerpo.error.data.supported, [VERSION], 'y la lista de las que sí, que es lo que el cliente necesita');
}

console.log('\n-- el saludo, que ya no es initialize --');
{
  const r = responder(pet('server/discover'), cabs('server/discover'), ctx());
  iguales(r.estado, 200, '200');
  iguales(r.cuerpo.result.resultType, 'complete', 'con resultType, que esta versión exige');
  iguales(r.cuerpo.result.supportedVersions, [VERSION], 'las versiones van en un array, no en un campo suelto');
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

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo en orden\n');
process.exit(fallos ? 1 : 0);
