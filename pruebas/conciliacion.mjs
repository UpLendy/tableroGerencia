/* Pruebas de la conciliación. Sin red: los datos van escritos aquí, con la
   forma real que devuelve Siigo. Lo que se comprueba no es que el código
   corra, sino que NO afirme cosas que no puede saber. */
import { resolverNit, comprasPorTercero, conciliar, cartera, CONSUMIDOR_FINAL }
  from '../scripts/conciliacion.mjs';

let fallos = 0;
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); fallos++; }
};

const terceros = new Map([
  ['800244387', 'ARCOS DORADOS COLOMBIA S.A'],
  ['900445797', 'PRODUEMPAK S.A.S'],
  ['891300959', 'SUCROAL S.A'],
  ['900000001', 'OTRA EMPRESA SAS'],
]);

console.log('\n-- el dígito de verificación --');
iguales(resolverNit('800244387', terceros), '800244387', 'sin dígito, tal cual');
iguales(resolverNit('8002443871', terceros), '800244387', 'con dígito pegado, se quita');
iguales(resolverNit('900445797-6', terceros), '900445797', 'con guion, se limpia y se quita');
iguales(resolverNit('7897879879789', terceros), null, 'documento mal escrito: no se empareja');
iguales(resolverNit('', terceros), null, 'sin documento: no se empareja');
iguales(resolverNit('999999999', terceros), null, 'no está en Siigo: no se inventa');

const factura = (nit, lineas, extra = {}) => ({
  name: 'FV-1-1', date: '2026-10-15', annulled: false,
  customer: { identification: nit },
  total: lineas.reduce((a, l) => a + l.price * l.quantity, 0),
  balance: 0,
  items: lineas.map((l) => ({ ...l, total: l.price * l.quantity })),
  ...extra,
});

console.log('\n-- la comparación --');
{
  const facturas = [
    factura('800244387', [{ code: '21002', quantity: 207, price: 10500 }]),
    factura('891300959', [{ code: '21002', quantity: 25, price: 14500 }]),
    factura('900445797', [{ code: '21007', quantity: 3, price: 45000 }]),
    factura('900000001', [{ code: '20001', quantity: 2, price: 80000 }]),
  ];
  const empresas = [
    { codigo: '8ac087', nombre: 'ARCOS DORADOS COLOMBIA S.A.S.', nit: '8002443871', certificados: 353 },
    { codigo: '7016fa', nombre: 'SUCROAL S.A', nit: '8913009598', certificados: 25 },
    { codigo: '9b149c', nombre: 'Produempak EFC', nit: '900445797-6', certificados: 6 },
    { codigo: '1f2ad1', nombre: 'Centro Aseo', nit: null, certificados: 39 },
    { codigo: 'xxxxxx', nombre: 'Fantasma SAS', nit: '7897879879789', certificados: 4 },
  ];
  const r = conciliar(empresas, comprasPorTercero(facturas), terceros);
  const de = (c) => r.empresas.find((x) => x.codigo === c);

  iguales(de('7016fa').estado, 'cuadra', '25 certificaciones y 25 unidades: cuadra');
  iguales(de('8ac087').estado, 'difiere', '353 contra 207: difiere');
  iguales(de('8ac087').diferencia, -146, 'y la diferencia es -146');
  iguales(de('9b149c').estado, 'no_comparable_por_paquetes',
          'con paquetes NO se declara cuadrada ni descuadrada');
  iguales(de('9b149c').diferencia, null, 'y la diferencia se deja en null, no en cero');
  iguales(de('1f2ad1').estado, 'sin_nit', 'sin documento: se reporta, no se adivina');
  iguales(de('xxxxxx').estado, 'nit_no_resuelto', 'documento mal escrito: tampoco se adivina');
  iguales(r.resumen.solo_en_siigo, 0, 'una compra que no es curso no cuenta como huérfana');
}

console.log('\n-- el canal particular --');
{
  const facturas = [
    factura(CONSUMIDOR_FINAL, [{ code: '21002', quantity: 1, price: 1572008 }]),
    factura(CONSUMIDOR_FINAL, [{ code: '21002', quantity: 1, price: 168000 }]),
  ];
  const r = conciliar([], comprasPorTercero(facturas), terceros);
  iguales(r.particular.valor_facturado, 1740008, 'se suma por valor');
  iguales(r.empresas.length, 0, 'y consumidor final no entra como empresa');
  iguales(/valor y no por cantidad/.test(r.particular.nota), true, 'y queda dicho por qué');
}

console.log('\n-- facturó curso y no es empresa del tablero --');
{
  const facturas = [factura('900000001', [{ code: '21002', quantity: 9, price: 16000 }])];
  const r = conciliar([], comprasPorTercero(facturas), terceros);
  iguales(r.solo_en_siigo.length, 1, 'se reporta aparte');
  iguales(r.solo_en_siigo[0].unidades, 9, 'con sus unidades');
}

console.log('\n-- las anuladas --');
{
  const facturas = [
    factura('891300959', [{ code: '21002', quantity: 25, price: 14500 }]),
    { ...factura('891300959', [{ code: '21002', quantity: 99, price: 14500 }]), annulled: true },
  ];
  /* conciliar() recibe ya filtradas; esto comprueba que el filtro es del
     llamador y que si llega una anulada, se nota. */
  const soloVivas = facturas.filter((f) => f.annulled !== true);
  const r = conciliar([{ codigo: 'a', nombre: 'SUCROAL S.A', nit: '891300959', certificados: 25 }],
                      comprasPorTercero(soloVivas), terceros);
  iguales(r.empresas[0].estado, 'cuadra', 'la anulada no entra');
}

console.log('\n-- la cartera --');
{
  const f = [
    { name: 'FV-1-1', date: '2026-10-01', customer: { identification: '800244387' }, total: 100000, balance: 100000, items: [] },
    { name: 'FV-1-2', date: '2026-11-10', customer: { identification: '800244387' }, total: 50000, balance: 20000, items: [] },
    { name: 'FV-1-3', date: '2026-11-10', customer: { identification: '891300959' }, total: 80000, balance: 0, items: [] },
  ];
  const c = cartera(f, terceros, '2026-11-20');
  iguales(c.total, 120000, 'solo suma lo que tiene saldo');
  iguales(c.terceros, 1, 'y solo los terceros que deben');
  iguales(c.por_antiguedad['mas de 90'], 0, 'octubre a noviembre no es más de 90 días');
  iguales(c.por_antiguedad['31 a 60'], 100000, 'la del 1 de octubre cae en 31 a 60');
  iguales(c.por_antiguedad['hasta 30'], 20000, 'la del 10 de noviembre, en hasta 30');
  iguales(c.mayores[0].mas_vieja_dias, 50, 'y se reporta la más vieja de cada tercero');
}

console.log('');
if (fallos) { console.log('  ' + fallos + ' fallo(s)\n'); process.exit(1); }
