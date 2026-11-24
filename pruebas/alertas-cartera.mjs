/* Pruebas de las alertas de cartera. Lo que se comprueba no es que corran,
   sino que no griten cuando no hay motivo, que no salgan hacia el Equipo, y
   que no afirmen nada que la cartera no diga. */
import { alertasDeCartera, alertasDeConciliacion, alertasDeFrescura, adjuntarCartera, UMBRALES } from '../scripts/alertas.mjs';
import { despojarParaEquipo } from '../scripts/vista.mjs';

let fallos = 0;
const cierto = (v, q) => {
  console.log((v ? '  ok   ' : '  FALLA ') + q);
  if (!v) fallos++;
};
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); fallos++; }
};

/** Una cartera con el reparto que se le pida, en porcentaje del total. */
const cartera = ({ vencidoPct = 10, concPct = 10, total = 100000000, dias = 400 } = {}) => ({
  regla: 'conciliacion-v1', corte: '2026-11-18', total, terceros: 20,
  por_antiguedad: {
    'hasta 30': total * (1 - vencidoPct / 100), '31 a 60': 0, '61 a 90': 0,
    'mas de 90': total * vencidoPct / 100, 'sin fecha': 0,
  },
  mayores: [
    { nit: '900155107', nombre: 'CLIENTE GRANDE S.A', saldo: total * concPct / 100, facturas: 3, mas_vieja_dias: dias },
    { nit: '800111222', nombre: 'CLIENTE CHICO S.A.S', saldo: total * 0.01, facturas: 1, mas_vieja_dias: 10 },
  ],
});

console.log('\n-- cuándo callan --');
iguales(alertasDeCartera(null).length, 0, 'sin cartera no dice nada');
iguales(alertasDeCartera({}).length, 0, 'cartera sin total no dice nada');
iguales(alertasDeCartera({ total: 0 }).length, 0, 'cartera en cero no dice nada');
iguales(alertasDeCartera(cartera({ vencidoPct: 10, concPct: 10 })).length, 0,
  'por debajo de los dos umbrales, ninguna alerta');

console.log('\n-- cuándo hablan --');
{
  const a = alertasDeCartera(cartera({ vencidoPct: UMBRALES.carteraVencida, concPct: 5 }));
  iguales(a.map((x) => x.id), ['cartera-vencida-2026-11'], 'justo en el umbral de vencido, sí avisa');
  iguales(a[0].severidad, 'atencion', 'en el umbral es atención, no crítica');
}
{
  const a = alertasDeCartera(cartera({ vencidoPct: UMBRALES.carteraVencida - 0.1, concPct: 5 }));
  iguales(a.length, 0, 'justo por debajo, no avisa');
}
iguales(alertasDeCartera(cartera({ vencidoPct: UMBRALES.carteraVencidaGrave, concPct: 5 }))[0].severidad,
  'critica', 'pasado el umbral grave, es crítica');
{
  const a = alertasDeCartera(cartera({ vencidoPct: 5, concPct: UMBRALES.carteraConcentracion }));
  iguales(a.map((x) => x.id), ['cartera-concentracion-2026-11'], 'concentración en el umbral, sí avisa');
}
iguales(alertasDeCartera(cartera({ vencidoPct: 5, concPct: UMBRALES.carteraConcentracionGrave }))[0].severidad,
  'critica', 'concentración grave es crítica');

console.log('\n-- qué dicen --');
{
  const a = alertasDeCartera(cartera({ vencidoPct: 50, concPct: 50, dias: 519 }));
  cierto(a.every((x) => x.para === 'gerencia'), 'las dos son de gerencia: nombran pesos y clientes');
  cierto(a.every((x) => x.accion && x.accion.length > 10), 'las dos traen acción');
  cierto(a.every((x) => x.seccion === 'cobrar'), 'las dos apuntan a la sección de cobrar');
  cierto(a[0].detalle.includes('519'), 'el detalle del vencido cita los días reales, no un redondeo');
  cierto(a[1].titulo.includes('CLIENTE GRANDE'), 'la de concentración nombra al cliente');
}
{
  /* Un tercero sin nombre útil en Siigo: se muestra el NIT, que sí sirve. */
  const c = cartera({ vencidoPct: 50, concPct: 50 });
  c.mayores[0].nombre = 'No aplica';
  const a = alertasDeCartera(c);
  cierto(a[1].titulo.includes('NIT 900155107'), 'sin nombre útil, se nombra por NIT');
  cierto(!a[1].titulo.includes('No aplica'), 'y no se repite el "No aplica" de Siigo');
}
{
  /* El mayor deudor puede no ser el más atrasado: la alerta de vencidos tiene
     que nombrar al mayor DE LOS VENCIDOS, no al mayor de todos. */
  const c = cartera({ vencidoPct: 50, concPct: 60 });
  c.mayores[0].mas_vieja_dias = 10;                       // el grande está al día
  c.mayores[1] = { nit: '800999', nombre: 'MOROSO S.A.S', saldo: c.total * 0.2, facturas: 9, mas_vieja_dias: 500 };
  cierto(alertasDeCartera(c)[0].detalle.includes('MOROSO'),
    'nombra al mayor de los vencidos, no al mayor deudor que está al día');
}

console.log('\n-- cómo se enganchan al corte --');
{
  const corte = { meses: [{ id: '2026-11', corto: 'Noviembre' }], alertas: [
    { id: 'vieja-aviso', severidad: 'aviso', para: 'todos', titulo: 'algo menor' },
  ] };
  adjuntarCartera(corte, cartera({ vencidoPct: 50, concPct: 50 }));
  cierto(!!corte.cartera, 'el bloque de cartera queda adjunto');
  /* Al 50 % las dos pasan su umbral grave, así que entran como críticas y
     tienen que quedar por delante del aviso que ya estaba. */
  iguales(corte.alertas.map((x) => x.severidad), ['critica', 'critica', 'aviso'],
    'las nuevas se ordenan con las viejas, lo grave primero');
}
{
  const corte = { meses: [{ id: '2026-11' }], alertas: [] };
  adjuntarCartera(corte, null);
  iguales([!!corte.cartera, corte.alertas.length], [false, 0], 'sin cartera no adjunta ni inventa alertas');
}

console.log('\n-- y no se le escapan al Equipo --');
{
  const corte = {
    corte: '2026-11-18', meses: [{ id: '2026-11', corto: 'Noviembre', cert: 10, personas: 9, ingreso: 100 }],
    alertas: [], empresas: [], serie: [],
  };
  adjuntarCartera(corte, cartera({ vencidoPct: 50, concPct: 50 }));
  const eq = despojarParaEquipo(JSON.parse(JSON.stringify(corte)));
  iguales(eq.cartera, undefined, 'el Equipo no recibe el bloque de cartera');
  iguales(eq.alertas.filter((a) => /cartera-/.test(a.id)).length, 0,
    'ni las alertas que salieron de ella');
  cierto(corte.alertas.some((a) => /cartera-/.test(a.id)),
    'pero Gerencia sí las conserva');
}

/* ===================================================== el cruce con Siigo */

/* Igual que lo que produce conciliar(), incluido sin_facturar, que es el
   campo que la alerta consume: el residuo despues del mes vencido. */
const emp = (codigo, cert, unidades, estado, extra = {}) => {
  const dif = estado === 'no_comparable_por_paquetes' ? null : unidades - cert;
  const ef = extra.posible_desfase ? Number(extra.diferencia_si_mes_vencido) : dif;
  const falta = Number.isFinite(ef) && dif != null ? Math.max(0, -ef) : 0;
  return {
    codigo, nombre: codigo.toUpperCase() + ' SAS', certificados: cert,
    unidades, diferencia: dif, estado,
    sin_facturar: falta, valor_sin_facturar: falta * 10000,
    ...extra,
  };
};
const cruce = (empresas, resumen = {}) => ({
  regla: 'conciliacion-v1', periodo: '2026-10', empresas,
  resumen: { total: empresas.length, cuadran: 0, difieren: 0, no_comparables: 0,
             certifican_sin_facturar: 0, sin_factura_en_el_periodo: 0,
             sin_nit: 0, nit_no_resuelto: 0, solo_en_siigo: 0, ...resumen },
});

console.log('\n-- el cruce: cuándo calla --');
iguales(alertasDeConciliacion(null).length, 0, 'sin cruce no dice nada');
iguales(alertasDeConciliacion({}).length, 0, 'un cruce sin resumen no dice nada');
iguales(alertasDeConciliacion(cruce([emp('a', 100, 100, 'cuadra')])).length, 0,
  'si todo cuadra, ninguna alerta');
iguales(alertasDeConciliacion(cruce([emp('a', 100, 90, 'difiere')])).length, 0,
  '10 sin facturar está por debajo del umbral: no avisa');

console.log('\n-- el cruce: lo que no se facturó --');
{
  const a = alertasDeConciliacion(cruce([emp('a', 100, 60, 'difiere')]));
  iguales(a.map((x) => x.id), ['cruce-sin-facturar-2026-10'], '40 sin facturar sí avisa');
  cierto(a[0].titulo.includes('40'), 'y dice cuántas');
  iguales(a[0].severidad, 'atencion', 'por debajo del umbral grave, es atención');
}
iguales(alertasDeConciliacion(cruce([emp('a', 400, 100, 'difiere')]))[0].severidad,
  'critica', '300 sin facturar es crítica');
{
  /* Facturar de MÁS no es lo mismo que no facturar, y no se mezcla. */
  const a = alertasDeConciliacion(cruce([emp('a', 100, 500, 'difiere')]));
  iguales(a.length, 0, 'que se facture de más no dispara la alerta de no facturado');
}
{
  /* Un paquete no se sabe cuántas certificaciones trae: sumarlo sería
     inventar el número que falta. */
  const a = alertasDeConciliacion(cruce([emp('a', 400, 0, 'no_comparable_por_paquetes')]));
  iguales(a.length, 0, 'los no comparables por paquete no se suman');
}
{
  const a = alertasDeConciliacion(cruce([
    emp('chica', 50, 10, 'difiere'), emp('grande', 300, 0, 'certifica_sin_facturar')]));
  cierto(a[0].detalle.includes('GRANDE'), 'nombra a la empresa con más sin facturar');
  cierto(a[0].titulo.includes('340'), 'y suma las dos');
}

{
  /* El caso Arcos, tal como lo corrigio BPM: se le factura a mes vencido, el
     desfase explica 122 de las 146, pero le quedan 24 SIN FACTURAR. Antes
     descontabamos la empresa entera y esos 24 desaparecian. */
  const arcos = emp('arcos', 353, 207, 'difiere',
    { posible_desfase: true, diferencia_si_mes_vencido: -24 });
  iguales(arcos.sin_facturar, 24, 'el residuo tras el mes vencido es 24, no 0 ni 146');
  const a = alertasDeConciliacion(cruce([arcos]));
  iguales(a.length, 0, '24 solo no pasa el umbral de 30, asi que no avisa');
}
{
  /* Y cuando ademas hay otra de verdad, el total los suma: el residuo del
     que va a mes vencido cuenta igual que el de los demas. */
  const a = alertasDeConciliacion(cruce([
    emp('arcos', 353, 207, 'difiere', { posible_desfase: true, diferencia_si_mes_vencido: -24 }),
    emp('otra', 100, 50, 'difiere'),
  ]));
  iguales(a.length, 1, 'la suma si pasa el umbral y avisa');
  cierto(a[0].titulo.includes('74'), 'suma el residuo de Arcos (24) con las 50 de la otra');
  cierto(/mes vencido/.test(a[0].detalle),
    'y marca cual lleva el mes vencido ya descontado');
  cierto(/ARCOS/.test(a[0].detalle) && /OTRA/.test(a[0].detalle),
    'y nombra a las dos, para saber a quien llamar');
}

console.log('\n-- el cruce: lo que hay que corregir --');
iguales(alertasDeConciliacion(cruce([], { total: 0, sin_nit: 2, nit_no_resuelto: 2 })).length, 0,
  '4 empresas por corregir está por debajo del umbral');
{
  const a = alertasDeConciliacion(cruce([], { total: 0, sin_nit: 17, nit_no_resuelto: 3 }));
  iguales(a.map((x) => x.id), ['cruce-datos-2026-10'], '20 sí avisa');
  cierto(a[0].titulo.includes('20'), 'con el total');
  cierto(a[0].detalle.includes('17') && a[0].detalle.includes('3'),
    'y separa las que no tienen NIT de las que lo tienen mal');
}

console.log('\n-- el cruce: a quién llega --');
{
  const a = alertasDeConciliacion(cruce([emp('a', 400, 0, 'certifica_sin_facturar')],
    { sin_nit: 10, nit_no_resuelto: 10 }));
  cierto(a.length === 2 && a.every((x) => x.para === 'gerencia'),
    'las dos son de gerencia');
  cierto(a.every((x) => x.seccion === 'cruce' && x.accion), 'con sección y acción');
}
{
  const corte = { meses: [{ id: '2026-11' }], alertas: [], empresas: [], serie: [], corte: '2026-11-18' };
  adjuntarCartera(corte, cartera({ vencidoPct: 50, concPct: 50 }),
    cruce([emp('a', 400, 0, 'certifica_sin_facturar')]));
  cierto(!!corte.conciliacion, 'el bloque del cruce queda adjunto');
  iguales(corte.alertas.filter((x) => /^cruce-/.test(x.id)).length, 1, 'y su alerta entra');
  const eq = despojarParaEquipo(JSON.parse(JSON.stringify(corte)));
  iguales(eq.conciliacion, undefined, 'el Equipo no recibe el cruce');
  iguales(eq.alertas.filter((x) => /^cruce-/.test(x.id)).length, 0, 'ni sus alertas');
}
{
  const corte = { meses: [], alertas: [], empresas: [], serie: [], corte: '2026-11-18' };
  adjuntarCartera(corte, cartera({ vencidoPct: 5, concPct: 5 }));
  iguales([corte.conciliacion, corte.alertas.length], [undefined, 0],
    'sin cruce no adjunta ni inventa alertas');
}

console.log('\n-- lo vencido no se diluye con la facturación nueva --');
{
  /* El 20 de noviembre la alerta decía «$28,5 M, el 36,5 % de la cartera». El
     24, con la misma deuda intacta, decía 24,4 % y se había callado: le habían
     facturado $37 M nuevos a Mall Plaza y el denominador crecio. La deuda no
     mejoro en un peso; el tablero dejo de hablar de ella. De ahi la segunda
     vara, que mide contra lo que BPM factura en un mes y no contra la cartera. */
  const mes = (v) => ({ facturado: v, cobrado: v, saldo: 0, facturas: 100 });
  const seisMeses = {
    '2026-05': mes(80e6), '2026-06': mes(80e6), '2026-07': mes(80e6),
    '2026-08': mes(80e6), '2026-09': mes(80e6), '2026-10': mes(80e6),
    '2026-11': mes(5e6),   // el mes en curso, a medias: no debe contar
  };
  const conDeuda = (total) => ({
    ...cartera({ vencidoPct: 28.6e6 / total * 100, concPct: 10, total }),
    facturado_por_mes: seisMeses,
  });

  const antes = alertasDeCartera(conDeuda(78e6)).filter((a) => /más de 90 días/.test(a.titulo));
  iguales(antes.length, 1, 'con $78 M de cartera, los $28,6 M vencidos avisan');

  const despues = alertasDeCartera(conDeuda(117e6)).filter((a) => /más de 90 días/.test(a.titulo));
  iguales(despues.length, 1, 'y con $117 M de cartera y la MISMA deuda, siguen avisando');
  cierto(/mes típico/.test(despues[0].detalle), 'diciendo a cuánto equivale en meses de facturación');
  cierto(/solo baja si se cobra/.test(despues[0].detalle),
    'y avisando de que esa cifra no baja porque se facture más');

  /* La mediana, no el promedio: un mes del doble no debe mover la vara. */
  const conMesRaro = {
    ...conDeuda(117e6),
    facturado_por_mes: { ...seisMeses, '2026-05': mes(400e6) },
  };
  const raro = alertasDeCartera(conMesRaro).filter((a) => /más de 90 días/.test(a.titulo));
  iguales(raro.length, 1, 'un mes atípico de $400 M no silencia la alerta');
  cierto(/\$80\./.test(raro[0].detalle), 'porque el mes típico sigue siendo la mediana, $80 M');

  /* Y que no avise cuando de verdad no hay por qué. */
  const sano = {
    ...cartera({ vencidoPct: 5, concPct: 10, total: 117e6 }),
    facturado_por_mes: seisMeses,
  };
  iguales(alertasDeCartera(sano).filter((a) => /más de 90 días/.test(a.titulo)).length, 0,
    'poca deuda vieja sobre mucha facturación: callado');

  /* Sin el bloque de facturación se comporta igual que antes. */
  const viejo = cartera({ vencidoPct: 10, concPct: 10 });
  iguales(alertasDeCartera(viejo).filter((a) => /más de 90 días/.test(a.titulo)).length, 0,
    'un corte sin facturado_por_mes vuelve a la regla de siempre');
  const viejoAlto = cartera({ vencidoPct: UMBRALES.carteraVencida + 1, concPct: 5 });
  iguales(alertasDeCartera(viejoAlto).filter((a) => /más de 90 días/.test(a.titulo)).length, 1,
    'y esa regla sigue funcionando sola');
}

console.log('\n-- el dato viejo --');
{
  /* El 20 de noviembre la lectura de Siigo no corrió y el tablero no dijo
     nada: la fecha estaba, en gris, al lado de un título. Esto es para que
     la próxima vez grite. Lo primero que hay que probar, sin embargo, es
     que NO grite el resto de los días. */
  const ahora = Date.parse('2026-11-20T15:00:00Z');
  const hace = (h) => ({ corte: '2026-11-20', generado_en: new Date(ahora - h * 36e5).toISOString() });

  iguales(alertasDeFrescura(hace(2), hace(2), ahora).length, 0, 'un dato de hace dos horas no dice nada');
  iguales(alertasDeFrescura(hace(25), hace(25), ahora).length, 0, 'ni uno de ayer dentro de la corrida diaria');
  iguales(alertasDeFrescura(UMBRALES.datoViejoHoras - 1 && hace(UMBRALES.datoViejoHoras - 1), null, ahora).length, 0,
    'justo por debajo del umbral, callado');

  const una = alertasDeFrescura(hace(UMBRALES.datoViejoHoras + 1), null, ahora);
  iguales(una.length, 1, 'pasada una corrida perdida, avisa');
  iguales(una[0].severidad, 'atencion', 'y es de atención, no crítica');
  cierto(una[0].para === 'gerencia', 'va a Gerencia');
  cierto(/sí se lee en vivo/.test(una[0].detalle),
    'y aclara que el resto del tablero no está viejo, que es el error contrario');
  cierto(una[0].seccion === 'cobrar', 'enlaza a la sección donde está el dato viejo');

  const dos = alertasDeFrescura(hace(UMBRALES.datoMuyViejoHoras + 1), null, ahora);
  iguales(dos[0].severidad, 'critica', 'con dos corridas perdidas, crítica');
  cierto(/dos lecturas seguidas/.test(dos[0].detalle), 'y lo dice');

  /* Las dos fuentes son el mismo proceso: dos alertas para un fallo es ruido. */
  const ambas = alertasDeFrescura(hace(40), hace(60), ahora);
  iguales(ambas.length, 1, 'cartera y cruce viejos a la vez dan una sola alerta');
  iguales(ambas[0].severidad, 'critica', 'y manda la más vieja de las dos');

  iguales(alertasDeFrescura(null, null, ahora).length, 0, 'sin datos no inventa una alerta');
  iguales(alertasDeFrescura({ corte: 'x' }, null, ahora).length, 0, 'sin fecha de generación tampoco');
  iguales(alertasDeFrescura({ corte: 'x', generado_en: 'mañana' }, null, ahora).length, 0,
    'una fecha que no se entiende no produce una alerta inventada');
  iguales(alertasDeFrescura(hace(-5), null, ahora).length, 0,
    'un reloj adelantado no produce un dato "de hace menos cero horas"');

  /* Y que de verdad llegue al corte, que es lo que ve la Dirección. */
  const corte = {};
  adjuntarCartera(corte, hace(72), null);
  cierto((corte.alertas || []).some((x) => /sin refrescarse/.test(x.titulo)),
    'adjuntarCartera la pone en el corte');

  /* Y va delante de las demás de su severidad: dice que las cifras con las
     que están hechas esas otras pueden no ser de hoy. */
  /* El otro fallo, y es el que se me escapo al escribirlo: que la cartera
     corra y el corte no. Entonces el dato de Siigo esta fresco y la alerta
     de arriba calla, pero el cruce esta hecho contra una lista de empresas
     vieja. La primera version comprobaba esto DESPUES de la salida temprana
     por dato fresco, de modo que no se habria disparado nunca en el unico
     caso para el que existe. */
  console.log('\n-- el corte rezagado, con la cartera al dia --');
  {
    const recien = new Date(ahora - 1 * 36e5).toISOString();
    const viejo = (h) => new Date(ahora - h * 36e5).toISOString();
    const fresca = { corte: '2026-11-24', generado_en: recien };

    const sinRezago = alertasDeFrescura(fresca,
      { corte_usado: { corte: '2026-11-24', generado_en: viejo(3) }, generado_en: recien, periodo: '2026-10' }, ahora);
    iguales(sinRezago.length, 0, 'corte de hace dos horas mas que la cartera: nada que decir');

    const conRezago = alertasDeFrescura(fresca,
      { corte_usado: { corte: '2026-11-19', generado_en: viejo(50) }, generado_en: recien, periodo: '2026-10' }, ahora);
    iguales(conRezago.length, 1, 'cartera fresca pero corte rezagado: SÍ avisa');
    cierto(/lista de empresas de hace/.test(conRezago[0].titulo), 'y dice que lo viejo es la lista de empresas');
    cierto(/no está afectado/.test(conRezago[0].detalle),
      'aclarando que lo que viene de Siigo no está afectado');
    cierto(/no el de la cartera/.test(conRezago[0].accion),
      'y señala al proceso que no corre, que es el del corte');
    iguales(conRezago[0].seccion, 'cruce', 'enlaza al cruce, que es lo que se degrada');

    const grave = alertasDeFrescura(fresca,
      { corte_usado: { corte: '2026-11-18', generado_en: viejo(96) }, generado_en: recien, periodo: '2026-10' }, ahora);
    iguales(grave[0].severidad, 'critica', 'con cuatro días de rezago, crítica');

    iguales(alertasDeFrescura(fresca, { generado_en: recien }, ahora).length, 0,
      'una conciliación vieja que no declara su corte no produce una alerta inventada');
    iguales(alertasDeFrescura(fresca,
      { corte_usado: { corte: 'x', generado_en: 'cuando sea' }, generado_en: recien }, ahora).length, 0,
      'ni una fecha que no se entiende');
  }

  const conOtras = { alertas: [
    { severidad: 'critica', titulo: 'otra crítica anterior' },
    { severidad: 'atencion', titulo: 'una de atención' },
  ] };
  adjuntarCartera(conOtras, hace(72), null);
  cierto(/sin refrescarse/.test(conOtras.alertas[0].titulo),
    'y la pone delante de las demás críticas, no detrás');
  iguales(conOtras.alertas.length, 3, 'sin perder ninguna por el camino');
}

console.log(fallos ? `\n  ${fallos} FALLO(S)\n` : '\n  todo bien\n');
process.exit(fallos ? 1 : 0);
