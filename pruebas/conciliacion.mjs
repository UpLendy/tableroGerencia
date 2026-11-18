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


console.log('-- la cartera no puede llegar a la vista de Equipo --');
{
  const { despojarParaEquipo, fugasDeEquipo } = await import('../scripts/vista.mjs');
  const corte = {
    corte: '2026-11-18', regla: 'r',
    meses: [{ id: '2026-11', cert: 10, personas: 9, ingreso: 200000, canal: { emp: 5, par: 5 } }],
    cartera: {
      total: 18713373, terceros: 14,
      por_antiguedad: { 'hasta 30': 1000, 'mas de 90': 17713373 },
      mayores: [{ nit: '900155107', nombre: 'UN CLIENTE SAS', saldo: 6383160, facturas: 7, mas_vieja_dias: 95 }],
    },
    alertas: [],
  };
  const equipo = despojarParaEquipo(corte);
  iguales(equipo.cartera, undefined, 'se quita el bloque entero, no campo por campo');
  iguales(corte.cartera.total, 18713373, 'y no se muta el original: Gerencia la sigue viendo');
  /* El detector recorre el corte buscando cualquier cosa con aspecto de
     dinero. Si mañana alguien mete la cartera en otro sitio, lo encuentra. */
  const fugas = fugasDeEquipo(equipo);
  iguales(fugas.length, 0, 'y el detector de fugas no encuentra dinero suelto');
  iguales(fugasDeEquipo(corte).length > 0, true, 'que sí lo encuentra si la cartera se cuela');
}

console.log('');


console.log('-- lo facturado mes a mes --');
{
  const { facturadoPorMes } = await import('../scripts/conciliacion.mjs');
  const f = [
    { date: '2026-10-05', total: 100000, balance: 0,
      items: [{ code: '21002', quantity: 5, price: 20000, total: 100000 }] },
    { date: '2026-10-20', total: 50000, balance: 50000,
      items: [{ code: '20001', quantity: 1, price: 50000, total: 50000 }] },
    { date: '2026-09-01', total: 30000, balance: 0, items: [] },
    { date: '', total: 999, balance: 0, items: [] },
  ];
  const r = facturadoPorMes(f);
  iguales(r['2026-10'].facturado, 150000, 'suma lo facturado del mes');
  iguales(r['2026-10'].cobrado, 100000, 'y lo cobrado es lo facturado menos el saldo de hoy');
  iguales(r['2026-10'].facturas, 2, 'cuenta las facturas');
  iguales(r['2026-10'].por_codigo['21002'].cantidad, 5, 'y guarda el desglose por código');
  iguales(Object.keys(r).sort(), ['2026-09', '2026-10'], 'una factura sin fecha no inventa un mes');
}

console.log('');

if (fallos) { console.log('  ' + fallos + ' fallo(s)\n'); process.exit(1); }

console.log('\n-- facturacion a mes vencido --');
{
  /* El caso de Arcos Dorados: certifica 353 en octubre, en octubre se le
     facturan 207 y en noviembre 329. Cruzar por fecha de factura lo declara
     descuadrado en 146; lo que pasa es que se le factura a mes vencido. */
  const octubre = [factura('800244387', [{ code: '21002', quantity: 207, price: 10500 }])];
  const noviembre = [factura('800244387', [{ code: '21002', quantity: 329, price: 10500 }])];
  const emp = [{ codigo: '8ac087', nombre: 'ARCOS DORADOS', nit: '800244387', certificados: 353 }];
  const t = new Map([['800244387', 'ARCOS DORADOS COLOMBIA S.A']]);

  const sinSiguiente = conciliar(emp, comprasPorTercero(octubre), t);
  iguales(sinSiguiente.empresas[0].diferencia, -146, 'sin el mes siguiente, la diferencia es -146');
  iguales(sinSiguiente.empresas[0].posible_desfase, undefined, 'y no se señala nada, porque no hay con que');

  const con = conciliar(emp, comprasPorTercero(octubre), t, comprasPorTercero(noviembre));
  const e = con.empresas[0];
  iguales(e.unidades_mes_siguiente, 329, 'con el mes siguiente, se publica lo facturado en noviembre');
  iguales(e.posible_desfase, true, 'y se marca como posible desfase');
  iguales(e.diferencia_si_mes_vencido, -24, 'con la diferencia que quedaria: -24');
  iguales(e.diferencia, -146, 'la diferencia por fecha de factura se conserva, no se reescribe');
  iguales(con.resumen.posible_desfase, 1, 'y el resumen los cuenta');
}
{
  /* Si el mes siguiente NO explica la diferencia, no se marca nada. Esto es
     lo que evita que la señal se dispare siempre y deje de significar algo. */
  const octubre = [factura('900111222', [{ code: '21002', quantity: 50, price: 14000 }])];
  const noviembre = [factura('900111222', [{ code: '21002', quantity: 3, price: 14000 }])];
  const emp = [{ codigo: 'abc123', nombre: 'OTRA', nit: '900111222', certificados: 100 }];
  const t = new Map([['900111222', 'OTRA SAS']]);
  const c = conciliar(emp, comprasPorTercero(octubre), t, comprasPorTercero(noviembre));
  iguales(c.empresas[0].posible_desfase, undefined, 'si el mes siguiente no lo explica, no se marca');
  iguales(c.resumen.posible_desfase, 0, 'y el resumen no lo cuenta');
}
{
  /* Una empresa que cuadra en su propio mes no se marca aunque el mes
     siguiente traiga algo: ya cuadraba. */
  const octubre = [factura('900111222', [{ code: '21002', quantity: 100, price: 14000 }])];
  const noviembre = [factura('900111222', [{ code: '21002', quantity: 100, price: 14000 }])];
  const emp = [{ codigo: 'abc123', nombre: 'OTRA', nit: '900111222', certificados: 100 }];
  const t = new Map([['900111222', 'OTRA SAS']]);
  const c = conciliar(emp, comprasPorTercero(octubre), t, comprasPorTercero(noviembre));
  iguales(c.empresas[0].estado, 'cuadra', 'sigue cuadrando');
  iguales(c.empresas[0].posible_desfase, undefined, 'y no se marca desfase');
}

{
  /* El falso positivo que casi se publica: una empresa a la que se le factura
     DE MAS en su mes y nada al siguiente. Cero queda cerca de cualquier
     numero pequeno, asi que una regla de distancias la marcaba como desfase y
     presentaba un -91 inventado en vez del +95 real. */
  const octubre = [factura('900333444', [{ code: '21002', quantity: 186, price: 11000 }])];
  const noviembre = [];
  const emp = [{ codigo: 'rf', nombre: 'ROYAL FILMS', nit: '900333444', certificados: 91 }];
  const t = new Map([['900333444', 'ROYAL FILMS S.A.S']]);
  const c = conciliar(emp, comprasPorTercero(octubre), t, comprasPorTercero(noviembre));
  iguales(c.empresas[0].posible_desfase, undefined, 'sin facturacion el mes siguiente no hay desfase que valga');
  iguales(c.empresas[0].diferencia, 95, 'y la diferencia real se conserva');
}
{
  /* Parecido no es igual: 7 contra 9 es un 22 % de diferencia y eso ya no es
     un desfase limpio, es otra cosa que hay que mirar. */
  const octubre = [factura('900555666', [{ code: '21002', quantity: 31, price: 11500 }])];
  const noviembre = [factura('900555666', [{ code: '21002', quantity: 7, price: 11500 }])];
  const emp = [{ codigo: 'cp', nombre: 'CINEPOLIS', nit: '900555666', certificados: 9 }];
  const t = new Map([['900555666', 'Cinepolis']]);
  const c = conciliar(emp, comprasPorTercero(octubre), t, comprasPorTercero(noviembre));
  iguales(c.empresas[0].posible_desfase, undefined, 'una diferencia del 22 % no se declara desfase');
}

{
  /* El caso que BPM pidio probar: una empresa facturada a mes vencido a la
     que, aun asi, le queda faltando. Arcos Dorados certifica 353, se le
     facturan 207 en octubre y 329 en noviembre: el desfase explica 122, pero
     quedan 24 sin facturar y esos 24 NO se pueden perdonar.
     Descontar la empresa entera por estar marcada como mes vencido fue
     exactamente el error que nos señalaron. */
  const octubre = [factura('800244387', [{ code: '21002', quantity: 207, price: 10500 }])];
  const noviembre = [factura('800244387', [{ code: '21002', quantity: 329, price: 10500 }])];
  const emp = [{ codigo: '8ac087', nombre: 'ARCOS DORADOS', nit: '800244387', certificados: 353 }];
  const t = new Map([['800244387', 'ARCOS DORADOS COLOMBIA S.A']]);
  const c = conciliar(emp, comprasPorTercero(octubre), t, comprasPorTercero(noviembre));
  const e = c.empresas[0];
  iguales(e.posible_desfase, true, 'se marca el mes vencido');
  iguales(e.sin_facturar, 24, 'pero le siguen faltando 24, no cero');
  iguales(e.valor_sin_facturar, 252000, 'y 24 a $10.500 son $252.000');
  iguales(c.resumen.sin_facturar, 24, 'el resumen cuenta el residuo, no el bruto de 146');
  iguales(c.resumen.valor_sin_facturar, 252000, 'y su valor');
}
{
  /* Y cuando el mes vencido lo explica entero, no queda nada. */
  const octubre = [factura('900111222', [{ code: '21002', quantity: 0, price: 14000 }])];
  const noviembre = [factura('900111222', [{ code: '21002', quantity: 40, price: 14000 }])];
  const emp = [{ codigo: 'x', nombre: 'EXACTA', nit: '900111222', certificados: 40 }];
  const t = new Map([['900111222', 'EXACTA SAS']]);
  const c = conciliar(emp, comprasPorTercero(octubre), t, comprasPorTercero(noviembre));
  iguales(c.empresas[0].sin_facturar, 0, 'si el mes siguiente lo cubre entero, no falta nada');
}
{
  /* Las filas que no tienen diferencia —sin NIT, o paquete— no pueden
     envenenar el total con un NaN. */
  const emp = [{ codigo: 'y', nombre: 'SIN DOC', nit: null, certificados: 50 }];
  const c = conciliar(emp, new Map(), new Map(), new Map());
  iguales(c.empresas[0].sin_facturar, 0, 'una empresa sin NIT no suma al faltante');
  iguales(Number.isFinite(c.resumen.sin_facturar), true, 'y el total sigue siendo un numero');
}

console.log('\n-- la cartera publica a todos, no a quince --');
{
  const fs = [];
  for (let i = 0; i < 20; i++)
    fs.push(factura('90000000' + i, [{ code: '21002', quantity: 1, price: 1000 }],
      { balance: 1000 * (20 - i), date: '2026-10-15' }));
  const c = cartera(fs, new Map(), '2026-11-18');
  iguales(c.detalle.length, 20, 'el detalle trae los veinte terceros');
  iguales(c.mayores.length, 15, 'y mayores sigue siendo el top quince');
  iguales(c.detalle[0].por_antiguedad['31 a 60'], 20000, 'cada tercero trae su reparto por tramo');
  const suma = c.detalle.reduce((a, x) => a + x.saldo, 0);
  iguales(Math.round(suma), Math.round(c.total), 'el detalle suma exactamente el total');
}



console.log('\n-- las que van dentro de la factura a consumidor final --');
{
  /* BPM confirmo que Punto Empleo, Normandy y GESA no se facturan aparte.
     Buscarles factura propia es buscar algo que no existe, asi que no pueden
     salir como "sin factura en el mes" ni como "NIT no resuelto". */
  const emp = [
    { codigo: 'pe', nombre: 'PUNTO EMPLEO S.A.S.', nit: null, certificados: 12 },
    { codigo: '14f27a', nombre: 'GESA GESTIONES ADMINISTRATIVAS', nit: '9017939810', certificados: 15 },
    { codigo: 'nm', nombre: 'Normandy S.A.', nit: null, certificados: 7 },
    { codigo: 'ok', nombre: 'OTRA SAS', nit: null, certificados: 5 },
  ];
  const c = conciliar(emp, new Map(), new Map());
  const por = (cod) => c.empresas.find((e) => e.codigo === cod).estado;
  iguales(por('pe'), 'via_consumidor_final', 'Punto Empleo no se busca aparte');
  iguales(por('14f27a'), 'via_consumidor_final', 'GESA tampoco, aunque tenga un NIT invalido');
  iguales(por('nm'), 'via_consumidor_final', 'Normandy tampoco');
  iguales(por('ok'), 'sin_nit', 'pero una empresa normal sin NIT sigue saliendo como tal');
  iguales(c.resumen.via_consumidor_final, 3, 'y el resumen las cuenta aparte');
  iguales(c.resumen.sin_nit, 1, 'sin inflar el conteo de las que hay que corregir');
}

{
  /* Cada empresa tiene que caer en exactamente un estado, y el resumen tiene
     que sumarlos todos. Añadir un estado nuevo y olvidarlo en el resumen fue
     un error real; esto lo caza sin depender de que alguien se acuerde. */
  const emp = [
    { codigo: 'a', nombre: 'CUADRA', nit: '800244387', certificados: 10 },
    { codigo: 'b', nombre: 'SIN DOC', nit: null, certificados: 5 },
    { codigo: 'c', nombre: 'GESA', nit: null, certificados: 3 },
    { codigo: 'd', nombre: 'NO ESTA', nit: '999999999', certificados: 2 },
  ];
  const fs = [factura('800244387', [{ code: '21002', quantity: 10, price: 10500 }])];
  const c = conciliar(emp, comprasPorTercero(fs), new Map([['800244387', 'ARCOS']]));
  const r = c.resumen;
  const suma = r.cuadran + r.difieren + r.no_comparables + r.certifican_sin_facturar +
               r.sin_factura_en_el_periodo + r.sin_nit + r.nit_no_resuelto +
               (r.via_consumidor_final || 0);
  iguales(suma, r.total, 'los estados del resumen suman el total de empresas');
  iguales(c.empresas.length, r.total, 'y hay una fila por empresa');
}

console.log('\n-- el caso simetrico: facturado de mas --');
{
  /* Royal Films: certifica 91 en octubre y se le facturan 186. BPM pregunta
     si eso es el servicio de septiembre facturado en octubre, o
     certificaciones hechas por fuera de la plataforma. Si en septiembre
     certifico ~186, es lo primero. */
  const octubre = [factura('900333444', [{ code: '21002', quantity: 186, price: 11000 }])];
  const emp = [{ codigo: 'rf', nombre: 'ROYAL FILMS', nit: '900333444', certificados: 91 }];
  const t = new Map([['900333444', 'ROYAL FILMS S.A.S']]);

  const sinAnterior = conciliar(emp, comprasPorTercero(octubre), t);
  iguales(sinAnterior.empresas[0].certificado_mes_anterior, undefined,
    'sin el mes anterior no se afirma nada');

  const cuadra = conciliar(emp, comprasPorTercero(octubre), t, new Map(), new Map([['rf', 180]]));
  iguales(cuadra.empresas[0].certificado_mes_anterior, 180, 'se publica lo certificado en septiembre');
  iguales(cuadra.empresas[0].facturado_corresponde_al_mes_anterior, true,
    '186 facturadas contra 180 certificadas el mes anterior: cuadra');

  const noCuadra = conciliar(emp, comprasPorTercero(octubre), t, new Map(), new Map([['rf', 20]]));
  iguales(noCuadra.empresas[0].facturado_corresponde_al_mes_anterior, undefined,
    'si en septiembre certifico 20, lo facturado no viene de alli');
  iguales(noCuadra.empresas[0].certificado_mes_anterior, 20,
    'pero el dato se publica igual, para que se vea');
}
{
  /* Sin dato del mes anterior no se inventa una explicacion. */
  const octubre = [factura('900333444', [{ code: '21002', quantity: 186, price: 11000 }])];
  const emp = [{ codigo: 'rf', nombre: 'ROYAL FILMS', nit: '900333444', certificados: 91 }];
  const t = new Map([['900333444', 'ROYAL FILMS']]);
  const c = conciliar(emp, comprasPorTercero(octubre), t, new Map(), new Map());
  iguales(c.empresas[0].facturado_corresponde_al_mes_anterior, undefined,
    'empresa sin historia el mes anterior: no se marca');
}

console.log(fallos ? `\n  ${fallos} FALLO(S)\n` : '\n  todo bien\n');
process.exit(fallos ? 1 : 0);
