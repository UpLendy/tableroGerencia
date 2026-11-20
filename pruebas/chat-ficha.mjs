/* Pruebas de la ficha que recibe el chat.

   Nacen de un fallo real: preguntada por las empresas que no se movieron en
   octubre, la Dirección recibió un "no se especifica cuáles". Y era verdad
   que no se especificaba: la ficha mandaba las 15 empresas de más volumen y
   nada más, y encima del mes en curso. La cartera y el cruce no iban.

   Lo que se comprueba aquí es lo que esa corrección tiene de peligroso: la
   ficha ahora lleva la lista entera de empresas con su NIT, quién debe cuánto
   y a quién falta facturarle. Si eso llegara a la vista de Equipo, el chat
   sería la puerta de atrás del tablero. Las dos mitades se prueban juntas. */
import { fichaDelCorte } from '../api/chat.mjs';
import { adjuntarCartera } from '../scripts/alertas.mjs';
import { despojarParaEquipo } from '../scripts/vista.mjs';
import { readFileSync } from 'node:fs';

let fallos = 0;
const cierto = (v, q) => {
  console.log((v ? '  ok   ' : '  FALLA ') + q);
  if (!v) fallos++;
};

const leer = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/* Un corte mínimo pero con la forma real, para no depender de los datos
   publicados: el que no tenga data/ al lado también tiene que poder probar. */
const corte = leer('data/corte.json') || {
  corte: '2026-11-20', regla: 'r1', origen: 'publicado',
  meses: [{ id: '2026-10', lbl: 'octubre', cert: 1847, personas: 1700, canal: { emp: 1800, par: 47 }, ingreso: 100, ingresoBPM: null, activas: 57, registradas: 78 },
          { id: '2026-11', lbl: 'noviembre', cert: 710, personas: 700, canal: { emp: 700, par: 10 }, ingreso: 50, ingresoBPM: null, activas: 40, registradas: 78 }],
  empresas: [],
};
/* Veinte empresas de pega, para que la prueba de "más allá del top 15" tenga
   algo que buscar incluso sin datos publicados. */
if (!(corte.empresas || []).length) {
  corte.empresas = Array.from({ length: 20 }, (_, i) => ({
    codigo: 'c' + i, nombre: 'EMPRESA ' + String(i).padStart(2, '0'), nit: '90000000' + i,
    meses: { '2026-10': 100 - i, '2026-11': i === 19 ? 0 : 50 - i },
  }));
}
const cartera = leer('data/cartera.json');
const conciliacion = leer('data/conciliacion.json');

const completo = structuredClone(corte);
if (cartera || conciliacion) adjuntarCartera(completo, cartera, conciliacion);
const fichaGerencia = fichaDelCorte(completo);
const fichaEquipo = fichaDelCorte(despojarParaEquipo(completo));

console.log('\n-- la Dirección sí puede llegar al detalle --');
cierto(/## Lista COMPLETA de las/.test(fichaGerencia), 'la ficha anuncia la lista completa de empresas');
{
  /* El fallo exacto: la empresa número 16 por volumen quedaba fuera. */
  const ids = [...new Set(completo.empresas.flatMap((e) => Object.keys(e.meses || {})))];
  const suma = (e) => ids.reduce((s, m) => s + Number((e.meses || {})[m] || 0), 0);
  const ordenadas = [...completo.empresas].sort((a, b) => suma(b) - suma(a));
  cierto(ordenadas.length > 15, 'hay más de 15 empresas, así que el top 15 dejaba fuera a alguien');
  const fuera = ordenadas[15];
  cierto(!!fuera && fichaGerencia.includes(fuera.nombre),
    `la empresa 16 por volumen (${fuera ? fuera.nombre : '?'}) aparece en la ficha`);
  const ultima = ordenadas[ordenadas.length - 1];
  cierto(!!ultima && fichaGerencia.includes(ultima.nombre),
    'la empresa de menos volumen también aparece');
  cierto(completo.empresas.every((e) => fichaGerencia.includes(e.nombre)),
    'todas las empresas del corte están nombradas, sin excepción');
}
cierto(/sin una sola certificación en/.test(fichaGerencia),
  'la ficha trae la lista de empresas sin movimiento en el último mes');

console.log('\n-- un cliente nuevo no es una empresa perdida --');
{
  /* El fallo: de las 21 empresas con cero en octubre, diez habian empezado
     en noviembre. Preguntado por «las que no se movieron en octubre», el
     modelo las daba por perdidas. */
  const ids = [...new Set(completo.empresas.flatMap((e) => Object.keys(e.meses || {})))].sort();
  const n = (e, m) => Number((e.meses || {})[m] || 0);
  const mesUlt = ids[ids.length - 1];
  const nuevas = completo.empresas.filter((e) => ids.slice(0, -1).every((m) => n(e, m) === 0) && n(e, mesUlt) > 0);
  const paradas = completo.empresas.filter((e) => n(e, mesUlt) === 0 && ids.some((m) => n(e, m) > 0));

  cierto(nuevas.length > 0, `hay ${nuevas.length} empresas que empezaron en ${mesUlt}`);
  cierto(nuevas.every((e) => fichaGerencia.includes(`${e.nombre}`)), 'todas aparecen');
  cierto(nuevas.every((e) => {
    const l = fichaGerencia.split('\n').find((x) => x.startsWith('- ' + e.nombre + ' '));
    return l && /no aparece antes de/.test(l);
  }), 'y su renglón dice que antes no aparecían, sin llamarlas clientes nuevos');
  cierto(paradas.every((e) => {
    const l = fichaGerencia.split('\n').find((x) => x.startsWith('- ' + e.nombre + ' '));
    return l && /sin certificar desde/.test(l);
  }), 'y el de las que sí dejaron de certificar dice desde cuándo');
  cierto(/## Empresas que aparecen por primera vez dentro de la ventana/.test(fichaGerencia),
    'además va la lista hecha, para no tener que deducirla de la tabla');
  cierto(/Nunca presentes como empresa perdida a una que todavía no había aparecido/.test(fichaGerencia),
    'y la instrucción explícita de no confundirlas');
  cierto(/no prueba que sea un cliente nuevo/.test(fichaGerencia),
    'y la advertencia de que la ventana de tres meses no basta para llamarla cliente nuevo');

  /* Una empresa que estuvo desde el principio y sigue activa no lleva marca:
     etiquetarlo todo es lo mismo que no etiquetar nada. */
  const siempre = completo.empresas.filter((e) => n(e, ids[0]) > 0 && n(e, mesUlt) > 0);
  cierto(siempre.length > 0 && siempre.every((e) => {
    const l = fichaGerencia.split('\n').find((x) => x.startsWith('- ' + e.nombre + ' '));
    return l && !/no aparece antes de|sin certificar desde/.test(l);
  }), 'las que llevan activas toda la ventana no llevan ninguna marca');
}
cierto(/mes parcial/.test(fichaGerencia),
  'y advierte que el cero del mes en curso no es todavía un abandono');

if (cartera) {
  console.log('\n-- cartera --');
  cierto(/## Cuentas por cobrar/.test(fichaGerencia), 'la ficha trae la cartera');
  cierto(/cartera BRUTA/.test(fichaGerencia), 'y declara que es bruta, no la neta de contabilidad');
  const mayor = [...(cartera.detalle || [])].sort((a, b) => b.saldo - a.saldo)[0];
  cierto(!!mayor && fichaGerencia.includes(mayor.nombre), 'el mayor deudor va con nombre');
  cierto((cartera.detalle || []).every((d) => fichaGerencia.includes(d.nit)),
    'están todos los terceros con saldo, no una muestra');
}

if (conciliacion) {
  console.log('\n-- certificado contra facturado --');
  cierto(/Certificado contra facturado del mes/.test(fichaGerencia), 'la ficha trae el cruce del mes');
  cierto(/Saldo acumulado de certificado contra facturado/.test(fichaGerencia), 'y el saldo acumulado');
  const con = (conciliacion.saldo?.empresas || []).filter((e) => Number(e.saldo) > 0);
  cierto(con.every((e) => fichaGerencia.includes(e.nombre)),
    `están las ${con.length} empresas con saldo sin facturar, todas`);
  cierto(/medida buena del atraso/.test(fichaGerencia),
    'y dice por qué el saldo acumulado manda sobre el mes suelto');
}

console.log('\n-- y el Equipo sigue sin ver nada de eso --');
cierto(!/## Cuentas por cobrar/.test(fichaEquipo), 'la ficha de Equipo no trae cartera');
cierto(!/Certificado contra facturado/.test(fichaEquipo), 'ni el cruce');
cierto(!/Saldo acumulado/.test(fichaEquipo), 'ni el saldo acumulado');
if (cartera && (cartera.detalle || []).length) {
  const mayor = [...cartera.detalle].sort((a, b) => b.saldo - a.saldo)[0];
  cierto(!fichaEquipo.includes(String(Math.round(mayor.saldo))),
    'ni el saldo del mayor deudor por ningún lado');
}
{
  /* La lista de empresas sí la ve el Equipo —es volumen, no dinero— pero sin
     el documento de nadie. Esto es lo que vista.mjs promete y lo que la ficha
     tiene que respetar al imprimirla. */
  const conNit = completo.empresas.filter((e) => e.nit);
  cierto(conNit.length > 0, 'hay empresas con NIT en el corte de Gerencia');
  cierto(conNit.every((e) => fichaGerencia.includes(`NIT ${e.nit}`)),
    'Gerencia ve el NIT de cada empresa');
  cierto(conNit.every((e) => !fichaEquipo.includes(e.nit)),
    'el Equipo no ve ni un NIT de empresa');
  cierto(completo.empresas.every((e) => fichaEquipo.includes(e.nombre)),
    'pero el Equipo sí ve los nombres y el volumen');
}

console.log('\n-- tamaño --');
console.log(`  ficha de Gerencia: ${fichaGerencia.length.toLocaleString('es-CO')} caracteres`);
console.log(`  ficha de Equipo:   ${fichaEquipo.length.toLocaleString('es-CO')} caracteres`);
cierto(fichaGerencia.length < 120000, 'la ficha cabe de sobra en el contexto del modelo');

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo en orden\n');
process.exit(fallos ? 1 : 0);
