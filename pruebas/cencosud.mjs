/* Pruebas de la quinta fuente: la plataforma de Cencosud.

   Todo lo que se prueba aquí salió de un error real, propio o de la base.

   La garantía de solo lectura no es una promesa en un comentario: es una
   lista de dos rutas, y ninguna de las dos puede escribir en Firestore. Se
   prueba que las de escritura se rechazan antes de salir a la red, porque es
   la clase de cosa que alguien añade sin darse cuenta dentro de seis meses.

   La deduplicación es el fallo más peligroso de esta fuente. El framework
   escribe cada documento en dos rutas con el mismo id, así que sin
   deduplicar las cifras salen al DOBLE EXACTO: un mes de 120 dice 240 y en
   la pantalla no hay nada visiblemente roto. Esta es la prueba que impide
   que vuelva.

   Y las tres cifras del mes son tres y no una. Ya pasó en la plataforma de
   formación que una empresa apareciera dos veces por contar códigos en vez
   de clientes; aquí el riesgo equivalente es confundir certificaciones con
   personas, y confundir «completó» con el «aprueba curso» del informe de
   Cencosud, que además exige 360 minutos de dedicación. */
import {
  resumir, deduplicar, filtrarCompletadas, mesDe, comprobarRuta, dentro,
  umbralDe, UMBRAL_POR_PROGRAMA, REGLA, PERMANENCIA_SEG,
} from '../scripts/cencosud.mjs';
import { alertasDeCencosud } from '../scripts/alertas.mjs';

let fallos = 0;
const cierto = (v, q) => { console.log((v ? '  ok   ' : '  FALLA ') + q); if (!v) fallos++; };
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); fallos++; }
};

console.log('\nSolo lectura por construcción');

cierto(comprobarRuta('runQuery') === 'runQuery', 'runQuery se permite');
cierto(comprobarRuta('runAggregationQuery') === 'runAggregationQuery', 'runAggregationQuery se permite');
for (const mala of ['commit', 'batchWrite', 'documents', 'createDocument', 'delete', '', 'runQuery:commit']) {
  let tiro = false;
  try { comprobarRuta(mala); } catch { tiro = true; }
  cierto(tiro, `se rechaza la ruta "${mala}"`);
}

console.log('\nLas dos copias de cada documento');

/* Lo mismo que devuelve Firestore: cada certificación dos veces, con el
   mismo id, porque está escrita bajo el usuario y bajo la certificación. */
const dobles = [
  { id: 'e1', mes: '2026-09', programa: 'carnicos', curso: 'c1', persona: 'ana', segundos: 25000 },
  { id: 'e1', mes: '2026-09', programa: 'carnicos', curso: 'c1', persona: 'ana', segundos: 25000 },
  { id: 'e2', mes: '2026-09', programa: 'carnicos', curso: 'c1', persona: 'beto', segundos: 10000 },
  { id: 'e2', mes: '2026-09', programa: 'carnicos', curso: 'c1', persona: 'beto', segundos: 10000 },
];
const d = deduplicar(dobles);
iguales(d.filas.length, 2, 'cuatro documentos son dos certificaciones');
iguales(d.brutas, 4, 'y se recuerda cuántos documentos llegaron');
iguales(d.copias, 2, 'y se publica el factor de copia: 2');

const sinDoblar = deduplicar([dobles[0], dobles[2]]);
iguales(sinDoblar.copias, 1, 'si algún día deja de duplicar, el factor baja a 1 y se ve');
iguales(deduplicar([]).copias, 0, 'con cero documentos no se divide por cero');

const tresCopias = deduplicar([...dobles, dobles[0], dobles[2]]);
iguales(tresCopias.copias, 3, 'y si apareciera una tercera copia, también se vería');
iguales(tresCopias.filas.length, 2, 'sin que las cifras se inflen');

cierto(deduplicar([{ mes: '2026-09', persona: 'ana' }]).filas.length === 0,
  'un documento sin id no se cuenta: no se puede saber si es una copia');

console.log('\nQué cuenta como certificación, y qué no');

/* Firestore no filtra nada de esto: filtrar por status u ordenar por fecha en
   un grupo de colecciones pide un índice que la base del cliente no tiene, y
   no vamos a modificarle la configuración de producción por esto. Se trae
   todo y se filtra aquí, así que el filtro tiene que ser correcto. */
const todos = [
  { id: 'a', estado: 'completed',   mes: '2026-09', persona: 'ana',   segundos: 30000 },
  { id: 'b', estado: 'in-progress', mes: null,      persona: 'beto',  segundos: 5000 },
  { id: 'c', estado: 'canceled',    mes: '2026-09', persona: 'caro',  segundos: 30000 },
  { id: 'd', estado: 'completed',   mes: '2026-08', persona: 'dani',  segundos: 30000 },
  { id: 'e', estado: 'completed',   mes: '2026-12', persona: 'eva',   segundos: 30000 },
  { id: 'f', estado: 'COMPLETED ',  mes: '2026-09', persona: 'fran',  segundos: 30000 },
  { id: 'g', estado: null,          mes: '2026-09', persona: 'gabo',  segundos: 30000 },
];
const enVentana = filtrarCompletadas(todos, { desde: '2026-09', hasta: '2026-11' });
const ids = enVentana.map((f) => f.id).sort();

iguales(ids, ['a', 'f'], 'solo lo completado y dentro de la ventana');
cierto(!ids.includes('b'), 'un avance en curso no es una certificación');
cierto(!ids.includes('c'), 'y uno cancelado tampoco, aunque tenga fecha');
cierto(!ids.includes('d'), 'lo de agosto queda fuera de una ventana que empieza en septiembre');
cierto(!ids.includes('e'), 'y lo de diciembre queda fuera de una que acaba en noviembre');
cierto(ids.includes('f'),
  'el estado se compara en minúsculas y sin espacios: en la base es texto libre');
cierto(!ids.includes('g'), 'sin estado no se da por completado');

const noviembre = filtrarCompletadas(todos, { desde: '2026-11', hasta: '2026-11' });
iguales(noviembre.length, 0, 'una ventana de un solo mes no se cuela el mes siguiente');
const conDiciembre = filtrarCompletadas(todos, { desde: '2026-12', hasta: '2026-12' });
iguales(conDiciembre.map((f) => f.id), ['e'], 'y el último mes de la ventana sí entra');

console.log('\nEl mes de una fecha, venga como venga');

cierto(mesDe({ timestampValue: '2026-09-14T15:04:00Z' }) === '2026-09', 'de una marca de tiempo');
cierto(mesDe({ stringValue: '2026-09-14T15:04:00.000Z' }) === '2026-09', 'de un texto ISO');
cierto(mesDe({ stringValue: '2026-09-14' }) === '2026-09', 'de un texto con solo la fecha');
cierto(mesDe(null) === null && mesDe({}) === null && mesDe({ integerValue: '5' }) === null,
  'lo que no es una fecha no inventa un mes');
cierto(mesDe({ stringValue: '14/09/2026' }) === null,
  'una fecha en formato colombiano NO se interpreta al revés: se descarta');

console.log('\nLos campos anidados');

/* Pedir un campo anidado en select NO devuelve la clave «a.b»: devuelve el
   mapa «a» entero. Por no saberlo, una sonda leyo null en los 122 cursos y
   parecia que ninguno tenia nota minima configurada. No era un dato. */
cierto(dentro({ testConfiguration: { minimunCalificationToPass: 75 } },
  'testConfiguration.minimunCalificationToPass') === 75,
  'se puede llegar a un campo dentro de un mapa');
cierto(dentro({ a: { b: 1 } }, 'a.z') === undefined, 'y lo que no esta sale undefined, no 0');
cierto(dentro(null, 'a.b') === undefined, 'sin reventar si no hay objeto');
cierto(dentro({ a: 0 }, 'a') === 0, 'y un cero de verdad se distingue de la ausencia');

console.log('\nLa permanencia va por programa, no una para todos');

const medidos = Object.entries(UMBRAL_POR_PROGRAMA).filter(([, u]) => u !== null).map(([k]) => k);
const sinMedir = Object.entries(UMBRAL_POR_PROGRAMA).filter(([, u]) => u === null).map(([k]) => k);
const [CARNICOS, BASICOS] = medidos;
const [OTC] = sinMedir;

cierto(PERMANENCIA_SEG === 21600,
  'los 360 minutos del informe son 21.600 segundos, porque time esta en segundos');
cierto(medidos.length >= 2 && sinMedir.length >= 1,
  'hay programas con umbral y al menos uno sin el');
iguales(umbralDe(CARNICOS), PERMANENCIA_SEG, 'carnicos tiene umbral');
iguales(umbralDe(OTC), null, 'el OTC no: nadie ha dicho cual es');
iguales(umbralDe('un-programa-que-aparecio-manana'), null,
  'y un programa nuevo NO hereda el de alimentos por descuido');

/* Junio de 2026 en pequeno: un mes dominado por el OTC. Con el umbral de
   alimentos aplicado a todo, este mes decia que cumplia el 20 %. */
const programas = {
  [CARNICOS]: { nombre: 'MANIPULACION DE ALIMENTOS CARNICOS CENCOSUD' },
  [BASICOS]: { nombre: 'MANIPULACION DE ALIMENTOS CENCOSUD' },
  [OTC]: { nombre: 'PROGRAMA DE MANEJO Y COMERCIALIZACION DE MEDICAMENTOS OTC' },
};
const cursos = {
  c1: { nombre: 'CARNICOS DEL 6 AL 12 DE OCTUBRE', empresa: 'cencosud', programa: CARNICOS },
  c2: { nombre: 'BASICOS SEPTIEMBRE', empresa: 'cencosud', programa: BASICOS },
  c3: { nombre: 'OTC JUNIO', empresa: 'cencosud', programa: OTC },
};
const junio = [
  { id: 'a', mes: '2026-06', programa: CARNICOS, curso: 'c1', persona: 'ana', segundos: 30000 },
  { id: 'b', mes: '2026-06', programa: BASICOS, curso: 'c2', persona: 'beto', segundos: 10000 },
  { id: 'c', mes: '2026-06', programa: OTC, curso: 'c3', persona: 'caro', segundos: 4000 },
  { id: 'd', mes: '2026-06', programa: OTC, curso: 'c3', persona: 'dani', segundos: 4500 },
  { id: 'e', mes: '2026-06', programa: OTC, curso: 'c3', persona: 'ana', segundos: 3900 },
];
const j = resumir(junio, programas, cursos).por_mes['2026-06'];

iguales(j.certificaciones, 5, 'el mes tiene cinco certificaciones');
iguales(j.personas, 4, 'y cuatro personas: Ana hizo dos programas');
iguales(j.permanencia_medida, 2, 'la permanencia se mide solo sobre los dos de alimentos');
iguales(j.cumplen_permanencia, 1, 'y cumple uno de esos dos');
iguales(j.permanencia_sin_umbral, 3, 'las tres del OTC quedan declaradas fuera del calculo');
cierto(j.cumplen_permanencia + (j.certificaciones - j.permanencia_medida) !== j.certificaciones ||
  j.permanencia_medida === j.certificaciones,
  'cumplen_permanencia se lee sobre permanencia_medida, nunca sobre certificaciones');

const otc = j.por_programa.find((p) => p.id === OTC);
iguales(otc.cumplen_permanencia, null,
  'el OTC dice null, no cero: «no se mide» y «nadie cumple» no son lo mismo');
iguales(otc.umbral_permanencia_seg, null, 'y publica que no tiene umbral');
iguales(otc.certificaciones, 3, 'pero sus certificaciones se cuentan igual');
iguales(otc.personas, 3, 'y sus personas tambien');

const car = j.por_programa.find((p) => p.id === CARNICOS);
iguales(car.cumplen_permanencia, 1, 'carnicos si trae su cumplimiento');
iguales(car.umbral_permanencia_seg, PERMANENCIA_SEG, 'y el umbral con el que se midio');

console.log('\nCertificaciones y personas son dos cifras distintas');

const filas = [
  { id: 'e1', mes: '2026-09', programa: CARNICOS, curso: 'c1', persona: 'ana', segundos: 25000 },
  { id: 'e2', mes: '2026-09', programa: BASICOS, curso: 'c2', persona: 'ana', segundos: 30000 },
  { id: 'e3', mes: '2026-09', programa: CARNICOS, curso: 'c1', persona: 'beto', segundos: 10000 },
  { id: 'e4', mes: '2026-10', programa: CARNICOS, curso: 'c1', persona: 'ana', segundos: 22000 },
  { id: 'e5', mes: '2026-10', programa: CARNICOS, curso: 'c1', persona: 'carlos', segundos: 21600 },
];
const r = resumir(filas, programas, cursos);

cierto(r.regla === REGLA, 'el resumen declara su regla');
iguales(r.por_mes['2026-09'].certificaciones, 3, 'septiembre: tres certificaciones');
iguales(r.por_mes['2026-09'].personas, 2, 'septiembre: dos personas, no tres');
iguales(r.por_mes['2026-09'].cumplen_permanencia, 2, 'septiembre: dos llegan a los 360 minutos');
iguales(r.por_mes['2026-10'].cumplen_permanencia, 2,
  'octubre: los 21.600 exactos cuentan, el umbral no es estricto');

iguales(r.total.certificaciones, 5, 'la ventana: cinco certificaciones');
cierto(r.total.personas === 3,
  'la ventana: tres personas. Ana se certifico en los dos meses y cuenta una vez');
cierto(r.por_mes['2026-09'].personas + r.por_mes['2026-10'].personas > r.total.personas,
  'y sumar los meses da mas: por eso el total se cuenta aparte');

console.log('\nLa empresa y el programa');

iguales(r.por_mes['2026-09'].empresas, ['cencosud'], 'el mes dice de que empresas es, via el curso');
const sep = r.por_mes['2026-09'].por_programa;
iguales(sep.length, 2, 'septiembre tiene dos programas');
iguales(sep[0].certificaciones, 2, 'va primero el de mas certificaciones');
cierto(sep.every((p) => p.nombre !== p.id), 'los programas salen con nombre, no con id');

const huerfana = resumir(
  [{ id: 'x', mes: '2026-09', programa: null, curso: 'desconocido', persona: 'a', segundos: 30000 }],
  programas, cursos,
);
iguales(huerfana.por_mes['2026-09'].por_programa[0].nombre, '(sin programa)',
  'una certificacion sin programa ni curso conocido no se reparte entre los demas');
iguales(huerfana.por_mes['2026-09'].empresas, [], 'y no se le inventa una empresa');
iguales(huerfana.por_mes['2026-09'].cumplen_permanencia, 0,
  'ni se le mide permanencia con un umbral que no es el suyo');
iguales(huerfana.por_mes['2026-09'].permanencia_medida, 0, 'su permanencia no se mide');

const delCurso = resumir(
  [{ id: 'y', mes: '2026-09', programa: null, curso: 'c2', persona: 'a', segundos: 30000 }],
  programas, cursos,
);
iguales(delCurso.por_mes['2026-09'].por_programa[0].id, BASICOS,
  'si falta el programa en el avance, se toma el del curso');
iguales(delCurso.por_mes['2026-09'].cumplen_permanencia, 1,
  'y entonces si se le aplica el umbral que le corresponde');

console.log('\nLo que llega roto no se cuenta como cero');

const sucias = resumir([
  { id: 'a', mes: null, programa: CARNICOS, curso: 'c1', persona: 'ana', segundos: 30000 },
  { id: 'b', mes: '2026-09', programa: CARNICOS, curso: 'c1', persona: null, segundos: 30000 },
  { id: 'c', mes: '2026-09', programa: CARNICOS, curso: 'c1', persona: 'zoe', segundos: NaN },
], programas, cursos);
cierto(!('null' in sucias.por_mes) && Object.keys(sucias.por_mes).length === 1,
  'una fila sin mes no crea un mes llamado "null"');
iguales(sucias.total.certificaciones, 2, 'y tampoco entra en el total de la ventana');
iguales(sucias.por_mes['2026-09'].certificaciones, 2, 'la fila sin persona si es una certificacion');
iguales(sucias.por_mes['2026-09'].personas, 1,
  'pero no es una persona: no se inventa una para no dejar el cero');
iguales(sucias.por_mes['2026-09'].cumplen_permanencia, 1,
  'y un tiempo que no es un numero no cumple permanencia por descarte');

console.log('\nLas alertas: pocas y solo las que significan que algo se rompio');

const base = (meses) => ({
  regla: REGLA, generado_en: new Date().toISOString(),
  por_mes: meses, total: { meses: Object.keys(meses).sort(), certificaciones: 0, personas: 0 },
});
const mes = (cert, cumplen, medidas) => ({
  certificaciones: cert, personas: cert, cumplen_permanencia: cumplen,
  permanencia_medida: medidas, permanencia_sin_umbral: cert - medidas,
  empresas: ['cencosud'], por_programa: [],
});

/* Seis meses buenos y el ultimo CERRADO desplomado. El mes en curso, que es
   el que va a medias, no se evalua: va siempre detras del ultimo cerrado. */
const caida = base({
  '2026-04': mes(100, 95, 100), '2026-05': mes(100, 94, 100),
  '2026-06': mes(100, 96, 100), '2026-07': mes(100, 95, 100),
  '2026-08': mes(100, 93, 100), '2026-09': mes(100, 60, 100),
  '2026-10': mes(10, 2, 10),
});
const aCaida = alertasDeCencosud(caida);
cierto(aCaida.some((a) => /permanencia/i.test(a.titulo)),
  'una caida de 35 puntos en el ultimo mes cerrado se avisa');
cierto(aCaida.every((a) => a.ir === 'cencosud'),
  'y la alerta sabe a que seccion llevar');

const estable = base({
  '2026-04': mes(100, 95, 100), '2026-05': mes(100, 94, 100),
  '2026-06': mes(100, 96, 100), '2026-07': mes(100, 95, 100),
  '2026-08': mes(100, 93, 100), '2026-09': mes(100, 92, 100),
  '2026-10': mes(10, 1, 10),
});
iguales(alertasDeCencosud(estable).length, 0,
  'un mes normal NO genera alerta: Monica ya pidio podar la lista');

const soloEnCurso = base({ '2026-10': mes(100, 20, 100) });
iguales(alertasDeCencosud(soloEnCurso).length, 0,
  'con un solo mes no hay con que comparar, y no se inventa una alerta');

const viejo = base({ '2026-09': mes(100, 95, 100) });
viejo.generado_en = new Date(Date.now() - 80 * 36e5).toISOString();
cierto(alertasDeCencosud(viejo).some((a) => /viej/i.test(a.titulo)),
  'un calculo de hace mas de tres dias se avisa: las cifras no son de hoy');

iguales(alertasDeCencosud(null).length, 0, 'sin datos no hay alertas');
iguales(alertasDeCencosud({}).length, 0, 'ni con un objeto vacio');

const ningunaMedida = base({
  '2026-04': mes(100, 0, 0), '2026-05': mes(100, 0, 0), '2026-06': mes(100, 0, 0),
  '2026-07': mes(100, 0, 0), '2026-08': mes(100, 0, 0), '2026-09': mes(100, 0, 0),
  '2026-10': mes(100, 0, 0),
});
iguales(alertasDeCencosud(ningunaMedida).length, 0,
  'si ningun mes mide permanencia, no se avisa de una caida que no se midio');

console.log(fallos ? `\n${fallos} fallos\n` : '\nTodo bien\n');
process.exit(fallos ? 1 : 0);
