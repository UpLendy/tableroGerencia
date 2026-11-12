import { congelar, deriva, sePuedeCongelar, registroVacio } from '../scripts/congelado.mjs';
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); process.exitCode = 1; }
};

console.log('\n-- cuando se puede congelar --');
iguales(sePuedeCongelar('2026-10', '2026-11-01'), false, 'el dia 1 del mes siguiente todavia no (cache de 24h)');
iguales(sePuedeCongelar('2026-10', '2026-11-02'), true,  'el dia 2 si');
iguales(sePuedeCongelar('2026-10', '2026-12-01'), false, 'dos meses despues ya no: esa cifra no es la de cierre');
iguales(sePuedeCongelar('2025-10', '2026-11-12'), false, 'un ano despues menos todavia');
iguales(sePuedeCongelar('2026-11', '2026-11-20'), false, 'el mes en curso nunca');
iguales(sePuedeCongelar('2026-12', '2026-11-20'), false, 'un mes futuro nunca');

const corte = (fecha, cert, ingreso) => ({
  corte: fecha, regla: 'virtual-metrics-v1',
  meses: [
    { id: '2026-10', cert, personas: 1700, ingreso, canal: { emp: 1068, par: 777 }, activas: 60,
      porCurso: [{ course_id: 'a', nombre: 'Manipulacion', precio: 20000, certificados: cert }] },
    { id: '2026-11', cert: 877, personas: 820, ingreso: 17540000, canal: { emp: 500, par: 377 }, activas: 40,
      porCurso: [{ course_id: 'a', nombre: 'Manipulacion', precio: 20000, certificados: 877 }] },
  ],
  serie: [{ periodo: '2025-10', certificados: 1518, personas: 1400 },
          { periodo: '2026-10', certificados: cert, personas: 1700 },
          { periodo: '2026-11', certificados: 877, personas: 820 }],
});

console.log('\n-- congelar --');
let { registro, nuevos } = congelar(registroVacio(), corte('2026-11-12', 1845, 36900000));
iguales(nuevos.map((x) => x.periodo), ['2026-10'], 'congela el mes que acaba de cerrar, no el que cerro hace un ano');
iguales(registro.meses['2026-10'].origen, 'resumen', 'octubre entra por el resumen, que trae mas');
iguales(registro.meses['2025-10'], undefined, 'octubre de 2025 no entra: ya habia derivado');
iguales(registro.meses['2026-10'].por_curso.length, 1, 'guarda el precio junto con la cifra');
iguales(registro.meses['2026-10'].cerrado_en, '2026-11-12', 'anota cuando se cerro');

console.log('\n-- de donde salio la cifra congelada --');
iguales(registro.meses['2026-10'].al_cierre, true, 'lo congelado es siempre cifra de cierre');
iguales(Object.keys(registro.meses), ['2026-10'], 'y no hay nada mas en el registro');

console.log('\n-- no se vuelve a tocar --');
const antes = JSON.parse(JSON.stringify(registro.meses['2026-10']));
({ registro, nuevos } = congelar(registro, corte('2026-11-20', 1840, 36800000)));
iguales(nuevos.length, 0, 'no vuelve a congelar lo ya cerrado');
iguales(registro.meses['2026-10'], antes, 'la cifra cerrada es intocable');

console.log('\n-- la cartera por empresa se congela con el total --');
/* El fallo que encontro la primera corrida real: el total quedaba congelado y
   el desglose por empresa se leia en vivo, asi que las empresas sumaban 1.070
   y canal.emp decia 1.071. El validador rechazo el corte, con razon. */
{
  const { aplicarCerrados } = await import('../scripts/congelado.mjs');
  const alCerrar = {
    corte: '2026-11-12', regla: 'r',
    meses: [{ id: '2026-10', cert: 1848, personas: 1700, ingreso: 1, canal: { emp: 1071, par: 777 }, activas: 2 },
            { id: '2026-11', cert: 877, personas: 820, ingreso: 1, canal: { emp: 1, par: 1 }, activas: 1 }],
    serie: [],
    empresas: [{ codigo: 'A', nombre: 'Arcos', meses: { '2026-10': 1000 } },
               { codigo: 'B', nombre: 'Beta',  meses: { '2026-10': 71 } }],
  };
  const { registro: reg } = congelar(registroVacio(), alCerrar);
  iguales(reg.meses['2026-10'].por_empresa.map((x) => [x.codigo, x.certificados]),
          [['A', 1000], ['B', 71]], 'guarda la cartera con el total');

  /* Un mes despues: Beta perdio uno por una renovacion y aparecio una empresa
     nueva con certificaciones en ese mes que antes no estaba. */
  const hoy = {
    corte: '2026-11-20', regla: 'r',
    meses: [{ id: '2026-10', cert: 1847, personas: 1699, ingreso: 1, canal: { emp: 1070, par: 777 }, activas: 3 },
            { id: '2026-11', cert: 900, personas: 840, ingreso: 1, canal: { emp: 1, par: 1 }, activas: 1 }],
    serie: [],
    empresas: [{ codigo: 'A', nombre: 'Arcos', meses: { '2026-10': 1000 } },
               { codigo: 'B', nombre: 'Beta',  meses: { '2026-10': 70 } },
               { codigo: 'C', nombre: 'Nueva', meses: { '2026-10': 4 } }],
  };
  aplicarCerrados(hoy, reg);
  const mes = hoy.meses.find((x) => x.id === '2026-10');
  const suma = hoy.empresas.reduce((a, e) => a + Number(e.meses['2026-10'] || 0), 0);
  iguales(mes.canal.emp, 1071, 'el canal vuelve a la cifra de cierre');
  iguales(suma, 1071, 'y la cartera vuelve a sumar lo mismo que el canal');
  iguales(hoy.empresas.find((e) => e.codigo === 'C').meses['2026-10'], 0,
          'una empresa que entro despues del cierre se va a cero');
}

console.log('\n-- deriva --');
const d = deriva(registro, corte('2026-11-20', 1840, 36800000));
iguales(d.filter((x) => x.periodo === '2026-10').map((x) => [x.campo, x.cerrado, x.ahora, x.diferencia]),
        [['cert', 1845, 1840, -5], ['ingreso', 36900000, 36800000, -100000]],
        'detecta las dos cifras que se movieron, con el signo correcto');
iguales(deriva(registro, corte('2026-11-20', 1845, 36900000)).length, 0, 'sin cambios, sin deriva');
iguales(deriva(registroVacio(), corte('2026-11-20', 1840, 36800000)).length, 0, 'registro vacio: nada que comparar');
console.log('');
