/* Pruebas de la lectura de Trello.

   Los datos de aquí están calcados de los dos tableros reales, porque las
   decisiones de diseño salieron de mirarlos: el responsable es el nombre de
   la columna y no el miembro asignado, lo vencido es la señal fiable, y las
   columnas de historial son 70 de 222 tarjetas en el tablero grande. Contar
   esas 70 haría que el informe dijera que hay 222 pendientes cuando hay 152,
   y que lo más grande del tablero fuera trabajo ya terminado. */
import { resumirTablero, armarTrello, esHistorial, DIAS_QUIETA } from '../scripts/trello.mjs';
import { alertasDeTrello, adjuntarTrello, UMBRALES } from '../scripts/alertas.mjs';
import { despojarParaEquipo } from '../scripts/vista.mjs';

let fallos = 0;
const cierto = (v, q) => { console.log((v ? '  ok   ' : '  FALLA ') + q); if (!v) fallos++; };
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); fallos++; }
};

const AHORA = Date.parse('2026-11-24T14:00:00Z');
const haceDias = (d) => new Date(AHORA - d * 864e5).toISOString();

console.log('\n-- qué columna es historial y cuál no --');
cierto(esHistorial('🗂️ Historial – cerradas y unificadas'), 'la de historial del tablero chico');
cierto(esHistorial('🗂️ Marcadas como hechas por el equipo – historial'), 'la del grande');
cierto(esHistorial('✅ Ventas pagadas (las pasa Claude según la caja)'), 'la de ventas pagadas');
cierto(!esHistorial('Pendientes seguimiento invima'), 'una de pendientes NO lo es');
cierto(!esHistorial('💰 Ventas (con cotización y FV)'), 'ni la de ventas por cobrar');
cierto(!esHistorial('Ana ( empresas, soporte empresas y cotizaciones )'), 'ni la de una persona');

console.log('\n-- el historial no cuenta como pendiente --');
{
  const listas = [
    { id: 'L1', name: 'Ana ( empresas )' },
    { id: 'L2', name: '🗂️ Marcadas como hechas por el equipo – historial' },
  ];
  const tarjetas = [
    ...Array.from({ length: 44 }, (_, i) => ({ id: 'a' + i, name: 'tarea', idList: 'L1',
      due: haceDias(1), dueComplete: true, dateLastActivity: haceDias(1) })),
    ...Array.from({ length: 70 }, (_, i) => ({ id: 'h' + i, name: 'hecha', idList: 'L2',
      due: null, dueComplete: false, dateLastActivity: haceDias(30) })),
  ];
  const r = resumirTablero({ id: 'B', nombre: 'Operación', url: 'u', listas, tarjetas }, { ahora: AHORA });
  iguales(r.vivas, 44, 'cuenta 44 pendientes, no 114');
  iguales(r.excluidas, [{ nombre: '🗂️ Marcadas como hechas por el equipo – historial', tarjetas: 70 }],
    'y dice en voz alta qué excluyó y cuántas eran');
  iguales(r.columnas.length, 1, 'la columna de historial no aparece en el reparto');
}

console.log('\n-- qué es una tarjeta vencida --');
{
  const listas = [{ id: 'L1', name: 'Pagos' }];
  const tarjetas = [
    { id: '1', name: 'vencida de verdad', idList: 'L1', due: haceDias(12), dueComplete: false, dateLastActivity: haceDias(1) },
    { id: '2', name: 'vencida pero ya hecha', idList: 'L1', due: haceDias(12), dueComplete: true, dateLastActivity: haceDias(1) },
    { id: '3', name: 'con fecha futura', idList: 'L1', due: new Date(AHORA + 5 * 864e5).toISOString(), dueComplete: false, dateLastActivity: haceDias(1) },
    { id: '4', name: 'sin fecha', idList: 'L1', due: null, dueComplete: false, dateLastActivity: haceDias(1) },
  ];
  const r = resumirTablero({ id: 'B', nombre: 'T', url: 'u', listas, tarjetas }, { ahora: AHORA });
  iguales(r.vencidas, 1, 'solo la que tiene fecha pasada y no está marcada hecha');
  iguales(r.lista_vencidas[0].dias, 12, 'y dice cuántos días lleva vencida');
  iguales(r.sin_fecha, 1, 'las que no llevan fecha se cuentan aparte, no como vencidas');
  cierto(r.lista_vencidas[0].columna === 'Pagos' && r.lista_vencidas[0].tablero === 'T',
    'cada vencida dice de qué tablero y columna sale');
}

console.log('\n-- una columna parada, no una tarjeta parada --');
{
  const listas = [
    { id: 'L1', name: '💰 Ventas (con cotización y FV)' },
    { id: 'L2', name: 'Sebas (contabilidad)' },
  ];
  const tarjetas = [
    /* Ventas: las seis quietas hace 28 días. Nadie mira esa columna. */
    ...Array.from({ length: 6 }, (_, i) => ({ id: 'v' + i, name: 'venta', idList: 'L1',
      due: null, dueComplete: false, dateLastActivity: haceDias(28) })),
    /* Sebas: una quieta entre muchas vivas. Eso no es un hallazgo. */
    { id: 's0', name: 'vieja', idList: 'L2', due: null, dueComplete: false, dateLastActivity: haceDias(30) },
    ...Array.from({ length: 46 }, (_, i) => ({ id: 's' + (i + 1), name: 'al día', idList: 'L2',
      due: null, dueComplete: false, dateLastActivity: haceDias(1) })),
  ];
  const r = resumirTablero({ id: 'B', nombre: 'Equipo', url: 'u', listas, tarjetas }, { ahora: AHORA });
  iguales(r.columnas_paradas.map((p) => p.columna), ['💰 Ventas (con cotización y FV)'],
    'solo señala la columna donde TODAS llevan quietas');
  iguales(r.columnas_paradas[0].dias, 28, 'con los días de la más quieta');
  cierto(DIAS_QUIETA === 14, 'el umbral de quieta es de 14 días');
}

console.log('\n-- varios tableros juntos --');
{
  const uno = resumirTablero({ id: 'A', nombre: 'Chico', url: 'u', listas: [{ id: 'L', name: 'Pagos' }],
    tarjetas: [{ id: '1', name: 'x', idList: 'L', due: haceDias(3), dueComplete: false, dateLastActivity: haceDias(1) }] }, { ahora: AHORA });
  const dos = resumirTablero({ id: 'B', nombre: 'Grande', url: 'u', listas: [{ id: 'M', name: 'Ana' }],
    tarjetas: [{ id: '2', name: 'y', idList: 'M', due: haceDias(20), dueComplete: false, dateLastActivity: haceDias(1) }] }, { ahora: AHORA });
  const t = armarTrello([uno, dos], { generado_en: '2026-11-24T14:00:00.000Z' });
  iguales(t.resumen.tableros, 2, 'suma los dos tableros');
  iguales(t.resumen.vivas, 2, 'y sus tarjetas vivas');
  iguales(t.vencidas.map((v) => v.dias), [20, 3], 'lo vencido va junto y ordenado por atraso, no por tablero');
  cierto(t.vencidas[0].tablero === 'Grande', 'diciendo de cuál viene cada una');
  cierto(!('lista_vencidas' in t.tableros[0]), 'sin repetir la lista dentro de cada tablero');
}

console.log('\n-- una tarjeta en una columna que no conocemos --');
{
  const r = resumirTablero({ id: 'B', nombre: 'T', url: 'u', listas: [{ id: 'L1', name: 'Pagos' }],
    tarjetas: [{ id: '1', name: 'huerfana', idList: 'DESCONOCIDA', due: haceDias(5), dueComplete: false, dateLastActivity: haceDias(1) }] },
    { ahora: AHORA });
  iguales(r.tarjetas_sin_columna, 1, 'se cuenta aparte en vez de desaparecer sin más');
  iguales(r.vencidas, 0, 'y no se mete en las cuentas de una columna que no existe');
}

console.log('\n-- cuándo avisa, y de qué --');
{
  const base = (vencidas, extra = {}) => ({
    regla: 'trello-v1', generado_en: '2026-11-24T14:00:00.000Z',
    vencidas, columnas_paradas: [],
    resumen: { tableros: 1, vivas: 100, vencidas: vencidas.length, sin_fecha: 0, columnas_paradas: 0, excluidas: 0 },
    ...extra,
  });
  const v = (dias, columna, nombre = 'x') => ({ tablero: 'T', columna, nombre, dias, url: null });

  iguales(alertasDeTrello(base([])).length, 0, 'sin vencidas, callado');
  iguales(alertasDeTrello(base([v(3, 'Pagos'), v(1, 'Ana')])).length, 0,
    'una tarjeta de ayer no es noticia: por debajo de los 7 días no avisa');

  const unaSemana = alertasDeTrello(base([v(UMBRALES.trelloVencidaDias, 'Pagos')]));
  iguales(unaSemana.length, 1, 'a los 7 días sí');
  iguales(unaSemana[0].severidad, 'atencion', 'y es de atención');
  iguales(unaSemana[0].para, 'gerencia', 'va a Gerencia: nombra columnas de personas');

  const tresSemanas = alertasDeTrello(base([v(UMBRALES.trelloVencidaDiasGrave, 'Pagos')]));
  iguales(tresSemanas[0].severidad, 'critica', 'a las tres semanas, crítica');

  /* Dónde se acumula manda sobre cuál es la peor. */
  const concentrada = alertasDeTrello(base([
    v(30, 'Ventas'), v(20, 'Sebas'), v(19, 'Sebas'), v(18, 'Sebas'), v(17, 'Sebas'),
  ]));
  cierto(/4 de las 5 están en una sola columna, «Sebas»/.test(concentrada[0].detalle),
    'si la mitad están en una columna, eso va primero');
  cierto(concentrada[0].detalle.indexOf('una sola columna') < concentrada[0].detalle.indexOf('La más atrasada'),
    'antes que la más atrasada, que al lado es una anécdota');

  const repartida = alertasDeTrello(base([v(30, 'A'), v(20, 'B'), v(19, 'C'), v(18, 'D'), v(17, 'E')]));
  cierto(/Repartidas entre 5 columnas/.test(repartida[0].detalle),
    'y si están repartidas, lo dice así en vez de señalar a nadie');

  /* El piso, que es la misma disciplina que la tasa de renovación. */
  const conSinFecha = alertasDeTrello(base([v(10, 'Pagos')], {
    resumen: { tableros: 1, vivas: 100, vencidas: 1, sin_fecha: 53, columnas_paradas: 0, excluidas: 0 } }));
  cierto(/piso y no un total/.test(conSinFecha[0].detalle),
    'avisa de que es un piso cuando hay tarjetas sin fecha');
  cierto(!/piso/.test(unaSemana[0].detalle),
    'y no lo dice cuando todas llevan fecha');
}

console.log('\n-- las columnas paradas --');
{
  const con = (paradas) => ({
    regla: 'trello-v1', generado_en: '2026-11-24T14:00:00.000Z', vencidas: [], columnas_paradas: paradas,
    resumen: { tableros: 1, vivas: 10, vencidas: 0, sin_fecha: 0, columnas_paradas: paradas.length, excluidas: 0 },
  });
  const a = alertasDeTrello(con([
    { tablero: 'T', columna: '💰 Ventas', tarjetas: 6, dias: 28 },
    { tablero: 'T', columna: 'Mensuales todos', tarjetas: 5, dias: 30 },
  ]));
  iguales(a.length, 2, 'una alerta por columna parada');
  cierto(a.every((x) => /No es una tarjeta olvidada/.test(x.detalle)),
    'y cada una explica que lo quieto es la columna entera, no una tarjeta');
  iguales(alertasDeTrello(con([{ tablero: 'T', columna: 'X', tarjetas: 2, dias: 3 }])).length, 0,
    'tres días quieta no es estar parada');
}

console.log('\n-- el Equipo no ve nada de esto --');
{
  const t = { regla: 'trello-v1', generado_en: '2026-11-24T14:00:00.000Z',
    vencidas: [{ tablero: 'T', columna: 'Ana', nombre: 'algo', dias: 30, url: null }],
    columnas_paradas: [],
    resumen: { tableros: 1, vivas: 10, vencidas: 1, sin_fecha: 0, columnas_paradas: 0, excluidas: 0 } };
  const corte = { meses: [], empresas: [], alertas: [{ severidad: 'aviso', para: 'todos', titulo: 'otra' }] };
  adjuntarTrello(corte, t);
  cierto(corte.alertas.some((x) => /Trello/.test(x.titulo)), 'adjuntarTrello pone la alerta en el corte');
  cierto(corte.alertas[0].severidad === 'critica', 'y la ordena por severidad');
  const eq = despojarParaEquipo(corte);
  cierto(!('trello' in eq), 'la vista de Equipo no trae el bloque de Trello');
  cierto(!(eq.alertas || []).some((x) => /Trello/.test(x.titulo)), 'ni sus alertas');
  cierto(!JSON.stringify(eq).includes('Ana'), 'ni el nombre de ninguna columna de persona');
}

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo en orden\n');
process.exit(fallos ? 1 : 0);
