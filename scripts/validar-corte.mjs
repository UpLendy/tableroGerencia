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
ok(Number(d.precioLista) > 0, 'precioLista: debe ser un número positivo');
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

  ok(Number(m.activas) <= Number(m.registradas),
     `${p}: activas (${nf(m.activas)}) supera registradas (${nf(m.registradas)})`);

  if (!(Number(m.ingreso) > 0)) avisos.push(`${p}: ingreso en cero o ausente`);
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
  ok(Number.isFinite(c.v) && c.v >= 0 && c.v <= 100, `salud · ${c.n}: valor fuera de 0–100`);
  ok((c.d || '').length > 20, `salud · ${c.n}: falta la fórmula en lenguaje llano`);
}
if (d.salud?.comp?.length) {
  const prom = Math.round(d.salud.comp.reduce((a, c) => a + c.v, 0) / d.salud.comp.length);
  ok(prom === Number(d.salud.total),
     `salud: el promedio de los componentes da ${prom}, pero total dice ${d.salud.total}`);
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
