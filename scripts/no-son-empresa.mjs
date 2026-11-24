/* ---------------------------------------------------------------------------
 * no-son-empresa.mjs — los códigos de la plataforma que NO son una empresa.
 *
 * Vive aparte porque hacen falta en dos sitios que no se pueden importar el
 * uno al otro: mapeo.mjs los excluye al armar la lista, y congelado.mjs no
 * puede resucitarlos al descongelar un mes cerrado. Si estuvieran en mapeo,
 * congelado tendría que importarlo y mapeo ya importa a congelado.
 * ------------------------------------------------------------------------- */
export const NO_SON_EMPRESA = new Map([
  ['bpmsas', 'bolsa de usuarios independientes que en algún momento quedaron ' +
             'bajo esa empresa; son más de 10.000 registros y no se pueden mover'],
  ['c777a6', 'cuenta de super administrador, con una certificación suelta de ' +
             'octubre de 2026 y un documento de 15 dígitos'],
  ['4w32sa', 'empresa de pruebas, confirmado por UpLendy el 20 de noviembre de ' +
             '2026. Una certificación de octubre y un documento de diez dígitos, ' +
             'que es una cédula y no un NIT'],
]);

export const noEsEmpresa = (codigo) => NO_SON_EMPRESA.has(String(codigo));
