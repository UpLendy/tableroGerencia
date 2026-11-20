/* Pruebas de la memoria de llamadas.

   La plataforma corta a las 60 peticiones por minuto y por IP, y todas las
   del tablero salen de la misma IP de Vercel. Cada clic en el selector de
   mes pedía doce cosas a formación, varias de ellas idénticas a las del
   clic anterior, así que tres meses seguidos rozaban el límite y el cuarto
   se llevaba un 429 delante de quien estuviera mirando.

   Lo que se prueba no es que la memoria guarde, sino lo único que importa:
   cuántas veces se sale a la red. Por eso aquí se cuenta fetch. */
import { pedir, olvidar } from '../scripts/llamadas.mjs';

let fallos = 0;
const cierto = (v, q) => {
  console.log((v ? '  ok   ' : '  FALLA ') + q);
  if (!v) fallos++;
};
const iguales = (a, b, q) => {
  const bien = a === b;
  console.log((bien ? '  ok   ' : '  FALLA ') + q + (bien ? '' : ` (esperaba ${b}, dio ${a})`));
  if (!bien) fallos++;
};

/* Una plataforma de mentira que cuenta cuántas veces la llaman. */
let llamadas = [];
let fallarCon = null;
const real = globalThis.fetch;
globalThis.fetch = async (url) => {
  llamadas.push(String(url));
  if (fallarCon) return new Response(String(fallarCon.cuerpo), { status: fallarCon.codigo });
  return new Response(JSON.stringify({ ok: true, regla: 'r1', dato: llamadas.length }), { status: 200 });
};
const limpiar = () => { llamadas = []; fallarCon = null; olvidar(); };
const P = { base: 'https://x.test/api/v1', token: 't' };

console.log('\n-- la misma llamada no sale dos veces --');
limpiar();
await pedir({ ...P, ruta: 'cursos', params: {} });
await pedir({ ...P, ruta: 'cursos', params: {} });
iguales(llamadas.length, 1, 'dos peticiones idénticas, una sola salida a la red');

console.log('\n-- pero dos distintas sí --');
limpiar();
await pedir({ ...P, ruta: 'certificaciones', params: { year: 2026, month: 10 } });
await pedir({ ...P, ruta: 'certificaciones', params: { year: 2026, month: 11 } });
iguales(llamadas.length, 2, 'distinto mes, dos salidas');

console.log('\n-- el orden de los parámetros no hace una llamada nueva --');
limpiar();
await pedir({ ...P, ruta: 'serie', params: { desde: '2026-01', hasta: '2026-11' } });
await pedir({ ...P, ruta: 'serie', params: { hasta: '2026-11', desde: '2026-01' } });
iguales(llamadas.length, 1, 'mismos parámetros en otro orden, una sola salida');

console.log('\n-- doce a la vez no son doce salidas --');
limpiar();
await Promise.all(Array.from({ length: 12 }, () => pedir({ ...P, ruta: 'vencimientos', params: { dias: 30 } })));
iguales(llamadas.length, 1, 'doce simultáneas idénticas comparten una sola petición');

console.log('\n-- un error no se queda guardado --');
limpiar();
fallarCon = { codigo: 500, cuerpo: 'boom' };
await pedir({ ...P, ruta: 'cursos', params: {}, intentos: 1 }).catch(() => {});
fallarCon = null;
const bueno = await pedir({ ...P, ruta: 'cursos', params: {} });
cierto(bueno && bueno.ok === true, 'tras un fallo, la siguiente vuelve a intentar y responde');
iguales(llamadas.length, 2, 'y sale a la red de nuevo en vez de servir el error guardado');

console.log('\n-- se puede pedir sin memoria --');
limpiar();
await pedir({ ...P, ruta: 'cursos', params: {} });
await pedir({ ...P, ruta: 'cursos', params: {}, sinMemoria: true });
iguales(llamadas.length, 2, 'sinMemoria obliga a leer de la plataforma');

console.log('\n-- el caso real: dos meses seguidos --');
limpiar();
/* Lo que pide el corte de un mes, simplificado a lo que de verdad varía. */
const unMes = (anio, mes, prev, prev2) => ([
  ['certificaciones', { year: anio, month: mes }],
  ['certificaciones', { year: anio, month: prev }],
  ['certificaciones', { year: anio, month: prev2 }],
  ['empresas', { year: anio, month: mes }],
  ['empresas', { year: anio, month: prev }],
  ['recompra', { year: anio, month: mes }],
  ['recompra', { year: anio, month: 9 }],
  ['serie', { desde: '2025-12', hasta: `${anio}-${String(mes).padStart(2,'0')}` }],
  ['vencimientos', { dias: 30 }],
  ['atribucion', { desde: `${anio}-${String(mes).padStart(2,'0')}-01` }],
  ['cursos', {}],
  ['calidad-dato', {}],
]);
await Promise.all(unMes(2026, 11, 10, 9).map(([ruta, params]) => pedir({ ...P, ruta, params })));
const trasNoviembre = llamadas.length;
await Promise.all(unMes(2026, 10, 9, 8).map(([ruta, params]) => pedir({ ...P, ruta, params })));
const trasOctubre = llamadas.length;
console.log(`     noviembre: ${trasNoviembre} llamadas · octubre después: ${trasOctubre - trasNoviembre} más · total ${trasOctubre}`);
iguales(trasNoviembre, 12, 'el primer mes cuesta las doce, que no hay nada guardado');
cierto(trasOctubre - trasNoviembre <= 6, 'el segundo mes cuesta seis o menos, no otras doce');
cierto(trasOctubre < 20, `los dos meses juntos caben de sobra en el límite de 60 por minuto (${trasOctubre})`);

globalThis.fetch = real;
console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo en orden\n');
process.exit(fallos ? 1 : 0);
