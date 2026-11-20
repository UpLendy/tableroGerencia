/* El NIT de cada empresa viaja de la plataforma al corte, y no llega al
   Equipo. Datos sintéticos: esto tiene que correr también en CI, donde no
   existe muestras/. */
import { armarEmpresas } from '../scripts/mapeo.mjs';
import { despojarParaEquipo } from '../scripts/vista.mjs';

let fallos = 0;
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); fallos++; }
};

/* Se prueba armarEmpresas directamente. Armar un corte entero para comprobar
   que un campo se transporta obliga a inventar media plataforma de mentira,
   y entonces lo que falla es el fixture, no el codigo. El camino completo ya
   lo cubre corte-offline.mjs con respuestas reales. */
const fila = (codigo, nombre, certificados, nit) => ({ codigo, nombre, certificados, personas: certificados, nit });
const mes = (periodo, filas) => ({ datos: { periodo, por_empresa: filas } });
const empresas = (act, prev = act) => armarEmpresas({ act: mes('2026-11', act), prev: mes('2026-10', prev) });
const una = (lista, codigo) => lista.find((e) => e.codigo === codigo);

console.log('\n-- el NIT llega al corte --');
{
  const c = empresas([fila('8ac087', 'ARCOS DORADOS S.A.S', 226, '8002443871')]);
  iguales(una(c, '8ac087').nit, '8002443871', 'se transporta tal cual, con su dígito de verificación');
  iguales(una(c, '8ac087').nits, undefined, 'sin desacuerdo no se deja lista');
}
{
  const c = empresas([fila('abc123', 'SIN DOCUMENTO SAS', 10, null)]);
  iguales(una(c, 'abc123').nit, null, 'sin documento en la plataforma, queda en null');
}
{
  const c = empresas([fila('abc123', 'VACIO SAS', 10, '   ')]);
  iguales(una(c, 'abc123').nit, null, 'un documento en blanco no cuenta como documento');
}

console.log('\n-- no se normaliza --');
{
  const c = empresas([fila('abc123', 'CON GUION SAS', 10, '900445797-6')]);
  iguales(una(c, 'abc123').nit, '900445797-6',
    'el guion se conserva: normalizar aquí haría irrecuperable el dígito');
}

console.log('\n-- los particulares no son una empresa --');
{
  const c = empresas([fila('(particular)', null, 370, null), fila('abc123', 'REAL SAS', 10, '900111222')]);
  iguales(c.map((e) => e.codigo), ['abc123'], 'la fila de particulares no entra');
}

console.log('\n-- los que no son una empresa --');
{
  /* La plataforma le pone user_enter_code a usuarios que no son empresas: la
     bolsa de independientes y, como salio el 19 de noviembre, una cuenta de
     super administrador con una certificacion suelta. Si entran, cuentan como
     cliente y ademas ensucian la lista de documentos por corregir. */
  const c = empresas([
    fila('bpmsas', 'Bolsa de independientes', 900, null),
    fila('c777a6', 'Super Admini Andrés', 1, '102369789661066'),
    fila('abc123', 'EMPRESA DE VERDAD SAS', 50, '900111222'),
  ]);
  iguales(c.map((e) => e.codigo), ['abc123'], 'solo entra la empresa de verdad');
}

console.log('\n-- empresas unificadas --');
{
  /* El mismo código en dos meses con el mismo documento: un solo NIT. */
  const c = empresas([fila('abc123', 'REAL SAS', 10, '900111222')],
                    [fila('abc123', 'REAL SAS', 8, '900111222')]);
  iguales(una(c, 'abc123').nit, '900111222', 'el mismo documento en dos meses no se duplica');
  iguales(una(c, 'abc123').nits, undefined, 'y no se reporta desacuerdo');
}
{
  /* Dos documentos distintos para el mismo código: se reportan los dos. No
     se elige uno en silencio, porque eso sería decidir cuál registro vale. */
  const c = empresas([fila('abc123', 'REAL SAS', 10, '9010711571')],
                    [fila('abc123', 'REAL SAS', 8, '7897879879789')]);
  const e = una(c, 'abc123');
  iguales(e.nits, ['9010711571', '7897879879789'], 'con desacuerdo se reportan los dos');
  iguales(e.nit, '9010711571', 'y nit se queda con el primero visto');
}

console.log('\n-- el Equipo no lo recibe --');
{
  const c = empresas([fila('abc123', 'REAL SAS', 10, '900111222'),
                      fila('def456', 'OTRA SAS', 5, '900333444')]);
  const corte = { corte: '2026-11-18', meses: [], serie: [], alertas: [], empresas: c };
  const eq = despojarParaEquipo(JSON.parse(JSON.stringify(corte)));
  iguales((eq.empresas || []).filter((e) => e.nit || e.nits).length, 0, 'ninguna empresa lleva documento');
  iguales(c.filter((e) => e.nit).length, 2, 'pero Gerencia sí lo conserva');
}

console.log(fallos ? `\n  ${fallos} FALLO(S)\n` : '\n  todo bien\n');
process.exit(fallos ? 1 : 0);
