/* Pruebas de las alertas de cartera. Lo que se comprueba no es que corran,
   sino que no griten cuando no hay motivo, que no salgan hacia el Equipo, y
   que no afirmen nada que la cartera no diga. */
import { alertasDeCartera, adjuntarCartera, UMBRALES } from '../scripts/alertas.mjs';
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

console.log(fallos ? `\n  ${fallos} FALLO(S)\n` : '\n  todo bien\n');
process.exit(fallos ? 1 : 0);
