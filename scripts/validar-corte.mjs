/**
 * validar-corte.mjs — guarda de consistencia de data/corte.json
 *
 *     npm run validar
 *
 * No comprueba que las cifras sean verdad; comprueba que no se contradigan
 * entre ellas. Sirve para que un corte mal pegado no llegue a producción
 * callado. Sale con código 1 si algo falla, para poder usarlo en CI.
 */
import { readFile } from 'node:fs/promises';

const RUTA = new URL('../data/corte.json', import.meta.url);
const fallos = [];
const avisos = [];
const ok = (cond, msg) => { if (!cond) fallos.push(msg); };
const nf = (n) => Number(n).toLocaleString('es-CO');

const d = JSON.parse(await readFile(RUTA, 'utf8'));

/* ---------------------------------------------------------- estructura */
ok(/^\d{4}-\d{2}-\d{2}$/.test(d.corte || ''), `corte: fecha inválida (${d.corte})`);
ok(typeof d.regla === 'string' && d.regla, 'regla: falta el identificador de la regla de cálculo');
ok(Number(d.precioMedioObservado) > 0,
   'precioMedioObservado: debe ser positivo (sale del valor del mes entre sus certificaciones)');
ok(Array.isArray(d.meses) && d.meses.length > 0, 'meses: debe haber al menos un periodo');
ok(Array.isArray(d.empresas), 'empresas: debe ser una lista');

/* ---------------------------------------------------------- por periodo */
for (const m of d.meses || []) {
  const p = `mes ${m.id}`;
  ok(/^\d{4}-\d{2}$/.test(m.id || ''), `${p}: id con formato inesperado`);
  ok(m.lbl && m.corto, `${p}: faltan las etiquetas lbl/corto`);

  const suma = Number(m.canal?.emp || 0) + Number(m.canal?.par || 0);
  ok(suma === Number(m.cert),
     `${p}: canal empresa + particular = ${nf(suma)}, pero cert = ${nf(m.cert)}`);

  ok(Number(m.personas) <= Number(m.cert),
     `${p}: hay más personas (${nf(m.personas)}) que certificaciones (${nf(m.cert)})`);

  const porEmpresa = (d.empresas || [])
    .reduce((a, e) => a + Number(e.meses?.[m.id] || 0), 0);
  ok(porEmpresa === Number(m.canal?.emp),
     `${p}: las empresas suman ${nf(porEmpresa)}, pero canal.emp dice ${nf(m.canal?.emp)}`);

  const activas = (d.empresas || []).filter((e) => Number(e.meses?.[m.id] || 0) > 0).length;
  ok(activas === Number(m.activas),
     `${p}: ${activas} empresas con movimiento, pero activas dice ${nf(m.activas)}`);

  if (m.registradas === null || m.registradas === undefined) {
    avisos.push(`${p}: no se conoce cuántas empresas hay registradas`);
  } else {
    ok(Number(m.activas) <= Number(m.registradas),
       `${p}: activas (${nf(m.activas)}) supera registradas (${nf(m.registradas)})`);
  }

  if (!(Number(m.ingreso) > 0)) avisos.push(`${p}: ingreso en cero o ausente`);
}

/* ---------------------------------------------------------- serie vs meses */
/* La inconsistencia que la Dirección encontró el 9 de noviembre: noviembre
   salía con 403 certificaciones en la serie y 436 en el resumen, y nada lo
   detectaba. Dos cifras del mismo mes en la misma pantalla destruyen la
   confianza en todas las demás. */
for (const m of d.meses || []) {
  const punto = (d.serie || []).find((x) => x.periodo === m.id);
  if (!punto) {
    avisos.push(`serie: no contiene el periodo ${m.id}, que sí está en el resumen`);
    continue;
  }
  ok(Number(punto.certificados) === Number(m.cert),
     `serie vs resumen · ${m.id}: la serie dice ${nf(punto.certificados)} ` +
     `certificaciones y el resumen ${nf(m.cert)}`);
  if (punto.personas !== undefined) {
    ok(Number(punto.personas) === Number(m.personas),
       `serie vs resumen · ${m.id}: la serie dice ${nf(punto.personas)} personas ` +
       `y el resumen ${nf(m.personas)}`);
  }
}

/* La serie debe ir en orden y sin huecos: un mes faltante se lee como caída. */
{
  const ps = (d.serie || []).map((x) => x.periodo);
  const ordenada = [...ps].sort();
  ok(JSON.stringify(ps) === JSON.stringify(ordenada), 'serie: los periodos no están en orden');
  for (let i = 1; i < ps.length; i++) {
    const [a, m1] = ps[i - 1].split('-').map(Number);
    const esperado = new Date(Date.UTC(a, m1, 1)).toISOString().slice(0, 7);
    ok(ps[i] === esperado, `serie: entre ${ps[i - 1]} y ${ps[i]} falta ${esperado}`);
  }
}

/* ---------------------------------------------------------- vencimientos */
if (d.venc) {
  const s = Number(d.venc.emp || 0) + Number(d.venc.par || 0);
  ok(s === Number(d.venc.total),
     `vencimientos: empresa + particular = ${nf(s)}, pero total = ${nf(d.venc.total)}`);
  ok(Number(d.venc.arcosActivo || 0) + Number(d.venc.arcosAntiguo || 0) === Number(d.venc.arcos || 0),
     'vencimientos: los dos códigos de Arcos no suman el total de Arcos');
  ok(Number(d.venc.arcos || 0) <= Number(d.venc.emp || 0),
     'vencimientos: Arcos no puede superar el total con empresa');
}

/* ---------------------------------------------------------- índice */
for (const c of d.salud?.comp || []) {
  if (c.v === null) {
    avisos.push(`salud · ${c.n}: sin valor en este corte (falta el insumo)`);
  } else {
    ok(Number.isFinite(c.v) && c.v >= 0 && c.v <= 100, `salud · ${c.n}: valor fuera de 0–100`);
  }
  ok((c.d || '').length > 20, `salud · ${c.n}: falta la explicación en lenguaje llano`);
}
{
  /* El total promedia solo los componentes que tienen valor. Un componente
     ausente no debe arrastrar el índice hacia abajo como si valiera cero. */
  const conValor = (d.salud?.comp || []).filter((c) => c.v !== null);
  if (conValor.length) {
    const prom = Math.round(conValor.reduce((a, c) => a + c.v, 0) / conValor.length);
    ok(prom === Number(d.salud.total),
       `salud: el promedio de los ${conValor.length} componentes con valor da ${prom}, ` +
       `pero total dice ${d.salud.total}`);
  }
}

/* ------------------------------------------------- semanas vs total */
/* El titular de vencimientos daba 1.489 mientras el desglose por canal y el
   de por semana daban los dos 1.412: la página se contradecía consigo misma
   en la misma tarjeta. El titular ya sale del dato; esto vigila el dato. */
if (d.venc && Array.isArray(d.venc.por_semana) && d.venc.por_semana.length) {
  const ss = d.venc.por_semana.reduce((a, x) => a + Number(x.vencen || 0), 0);
  ok(ss === Number(d.venc.total),
     `vencimientos: las semanas suman ${nf(ss)}, pero total dice ${nf(d.venc.total)}`);
}

/* ---------------------------------------------------- puntaje de calidad */
/* El HTML traía un 80 escrito a mano mientras la plataforma reportaba 67.
   El puntaje que se muestra es el de la fuente; aquí se exige que exista. */
if (Array.isArray(d.calidad) && d.calidad.length) {
  const r = d.calidadResumen;
  ok(r && Number.isFinite(Number(r.puntaje)),
     'calidad: hay verificaciones pero calidadResumen.puntaje no viene, ' +
     'y el tablero no debe inventar un puntaje propio');
  if (r) ok(r.regla, 'calidad: calidadResumen no declara la regla que lo produjo');
}

/* ------------------------------------------------- detenidas Alimentia */
/* La empresa que nunca diligenció es la más detenida de todas y era justo la
   que no aparecía. Que vuelva a desaparecer tiene que romper el corte. */
if (d.alimentia) {
  const a = d.alimentia;
  const det = a.detenidas || [];
  const nunca = Number(a.nunca_han_diligenciado || 0);
  const enLista = det.filter((e) => e.nunca_empezo).length;
  ok(enLista === nunca,
     `alimentia: ${nf(nunca)} empresa(s) nunca diligenciaron pero solo ${nf(enLista)} ` +
     `figura(n) en detenidas; la que nunca empezó no puede faltar`);
  for (const e of det) {
    ok(e.nunca_empezo || Number(e.dias_sin_diligenciar || 0) >= 7,
       `alimentia · ${e.nombre}: está en detenidas con ${e.dias_sin_diligenciar} día(s) ` +
       `sin diligenciar y sin ser de las que nunca empezaron`);
  }
  if (a.detenidas_endpoint != null && a.detenidas_endpoint !== det.length) {
    avisos.push(`alimentia: el endpoint reporta ${nf(a.detenidas_endpoint)} detenida(s) y ` +
                `el tablero deriva ${nf(det.length)} · revisar del lado de Alimentia`);
  }
}

/* ---------------------------------------------------------- códigos */
const vistos = new Set();
for (const e of d.empresas || []) {
  ok(e.codigo && e.nombre, `empresa sin código o sin nombre: ${JSON.stringify(e).slice(0, 60)}`);
  ok(!vistos.has(e.codigo), `código de empresa repetido: ${e.codigo}`);
  vistos.add(e.codigo);
}

/* ---------------------------------------------------------- salida */
for (const a of avisos) console.log(`  aviso   ${a}`);
if (fallos.length) {
  console.error(`\n${fallos.length} problema(s) en data/corte.json:\n`);
  for (const f of fallos) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`\n✓ corte ${d.corte} consistente · ${d.meses.length} periodo(s) · ${d.empresas.length} empresas\n`);
