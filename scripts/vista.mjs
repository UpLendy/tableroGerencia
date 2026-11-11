/* ---------------------------------------------------------------------------
 * vista.mjs — qué ve cada quien.
 *
 * El bloque D de COT-2026-TABLERO-01 pide separar las vistas: «Gerencia con
 * dinero y cifras individuales, Equipo solo con semáforos», y su criterio de
 * aceptación es que «la vista de Equipo no exponga ninguna cifra de dinero ni
 * porcentaje individual».
 *
 * Eso no se cumple ocultando en pantalla. Si el corte completo llega al
 * navegador y el CSS tapa las cifras, cualquiera abre el inspector y las lee:
 * sería maquillaje, no separación. Aquí el corte se despoja ANTES de salir del
 * servidor, de modo que a la vista de Equipo la cifra no le llega.
 *
 * Qué se quita, y por qué cada cosa:
 *
 *   dinero              cualquier valor en pesos, en cualquier bloque.
 *   cifras individuales lo que se puede atribuir a una persona con nombre:
 *                       la carga de cada ingeniero, quién está sobrecargado,
 *                       su avance y su mediana de cierre, el retrabajo por
 *                       ingeniero. El equipo sí puede ver que hay reparto
 *                       desigual; no quién es el señalado.
 *
 * Qué se conserva: todo lo que es semáforo o volumen. Certificaciones,
 * personas, empresas activas, cumplimiento, calidad del dato, índice de salud,
 * cuellos de botella por etapa y conteos de vencimientos. El equipo tiene que
 * poder trabajar con esto.
 *
 * Una advertencia que no hay que perder de vista: mientras el tablero sea
 * público y no tenga autenticación, esto separa lo que cada vista RECIBE, no
 * quién puede pedir cada vista. Cualquiera que conozca la dirección puede
 * pedir la de Gerencia. Para que sea un control de acceso de verdad hace falta
 * autenticación, y así está dicho en el README.
 * ------------------------------------------------------------------------- */

export const VISTAS = ['gerencia', 'equipo'];

export const esVista = (v) => VISTAS.includes(String(v || '').toLowerCase().trim());

/** Campos en pesos, por bloque. Si se agrega uno nuevo, va aquí. */
const DINERO_MES = ['ingreso', 'ingresoBPM'];

/** Quita las claves indicadas de un objeto, si existe. */
const sin = (obj, claves) => {
  if (!obj || typeof obj !== 'object') return obj;
  const r = { ...obj };
  for (const k of claves) delete r[k];
  return r;
};

/**
 * Devuelve una copia del corte sin dinero ni cifras atribuibles a una persona.
 * No muta el original: el mismo proceso sirve las dos vistas.
 */
export function despojarParaEquipo(corte) {
  if (!corte || typeof corte !== 'object') return corte;
  const c = structuredClone(corte);

  c.vista = 'equipo';
  c.vista_nota =
    'Vista de Equipo: sin cifras de dinero ni datos por persona. ' +
    'El corte se despoja en el servidor, de modo que esas cifras no llegan a esta página.';

  /* ---------------------------------------------------------------- meses */
  c.meses = (c.meses || []).map((m) => sin(m, DINERO_MES));

  /* ------------------------------------------------------------ precio */
  delete c.precioMedioObservado;

  /* ------------------------------------------------------- vencimientos
     El conteo se queda —el equipo tiene que saber cuántos vencen— y se va
     todo lo que lo convierte en pesos. */
  if (c.venc) c.venc = sin(c.venc, ['valor', 'recompra_potencial']);

  /* ------------------------------------------------------------ recompra
     Las tasas son del conjunto, no de una persona, así que se quedan. Lo que
     se va es el dinero que no volvió. */
  for (const k of ['recompra', 'recompra_cerrada']) {
    if (c[k]) c[k] = sin(c[k], ['valor_no_renovado', 'recompra_potencial']);
  }

  /* -------------------------------------------------------------- cursos
     El catálogo se queda sin el precio de cada curso. El equipo puede ver qué
     se está certificando; cuánto vale es de Gerencia. */
  if (c.cursos && Array.isArray(c.cursos.cursos)) {
    c.cursos.cursos = c.cursos.cursos.map((x) => sin(x, ['precio', 'alerta_sin_precio']));
    c.cursos = sin(c.cursos, ['cursos_con_certificaciones_sin_precio']);
  }

  /* ------------------------------------------------------------ trámites
     Aquí está lo delicado. El reparto desigual es un hecho del equipo y se
     queda; quién carga con qué, no. Se conservan los conteos agregados y los
     tiempos por etapa, que es de lo que el equipo tiene que poder hablar. */
  if (c.tramites) {
    if (c.tramites.ingenieros) {
      const i = c.tramites.ingenieros;
      c.tramites.ingenieros = {
        activos: i.activos,
        con_carga: i.con_carga,
        sin_carga: i.sin_carga,
        carga_mediana: i.carga_mediana,
        reparto_desigual: i.reparto_desigual,
        criterio_sobrecarga: i.criterio_sobrecarga,
        que_mide_la_carga: i.que_mide_la_carga,
        sin_carga_con_citas: i.sin_carga_con_citas,
        citas_periodo_total: i.citas_periodo_total,
        /* Cuántos superan el criterio sí; quiénes son, no. */
        sobrecargados_total: (i.sobrecargados || []).length,
      };
    }
    if (c.tramites.retrabajo) {
      c.tramites.retrabajo = sin(c.tramites.retrabajo, ['por_ingeniero']);
    }
    if (c.tramites.duracion) {
      c.tramites.duracion = sin(c.tramites.duracion, ['valor', 'ingreso']);
    }
  }

  /* ----------------------------------------------------------- Alimentia
     El cumplimiento por empresa no es una cifra individual: una empresa no es
     una persona, y el equipo necesita ver qué cliente dejó de diligenciar.
     No hay dinero en este bloque. Se queda como está. */

  /* ---------------------------------------------------------- prioridades
     Las redacta una persona y pueden nombrar cifras de dinero. Hasta que haya
     una versión para equipo, no se envían. */
  delete c.prioridades;
  delete c.narrativa;

  return c;
}

/**
 * Recorre el corte y devuelve lo que no debería estar en la vista de Equipo.
 * Es la misma pregunta que hace el criterio de aceptación, y por eso el
 * validador y las pruebas la usan en vez de confiar en la lista de arriba:
 * si mañana aparece un campo nuevo con pesos, esto lo encuentra.
 */
export function fugasDeEquipo(corte) {
  const fugas = [];
  const SOSPECHOSO = /(ingreso|precio|valor|recompra_potencial|facturad|pesos|cop)/i;
  const PERMITIDO = /^(valor(es)?_(esperado|contado)|precioMedio_nota)$/;

  const mirar = (nodo, ruta) => {
    if (nodo === null || nodo === undefined) return;
    if (Array.isArray(nodo)) {
      nodo.forEach((x, i) => mirar(x, `${ruta}[${i}]`));
      return;
    }
    if (typeof nodo === 'object') {
      for (const [k, v] of Object.entries(nodo)) mirar(v, ruta ? `${ruta}.${k}` : k);
      return;
    }
    const clave = ruta.split('.').pop().replace(/\[\d+\]$/, '');
    if (typeof nodo === 'number' && SOSPECHOSO.test(clave) && !PERMITIDO.test(clave)) {
      fugas.push({ ruta, valor: nodo, motivo: 'campo con aspecto de dinero' });
    }
    if (typeof nodo === 'string' && /\$\s?\d/.test(nodo)) {
      fugas.push({ ruta, valor: nodo.slice(0, 80), motivo: 'texto con una cifra en pesos' });
    }
  };

  mirar(corte, '');

  /* Personas con nombre y una cifra al lado. */
  const ing = corte?.tramites?.ingenieros;
  if (ing) {
    if (Array.isArray(ing.detalle) && ing.detalle.length)
      fugas.push({ ruta: 'tramites.ingenieros.detalle', motivo: 'carga por persona con nombre' });
    if (Array.isArray(ing.sobrecargados) && ing.sobrecargados.length)
      fugas.push({ ruta: 'tramites.ingenieros.sobrecargados', motivo: 'señala a personas por nombre' });
  }
  if (Array.isArray(corte?.tramites?.retrabajo?.por_ingeniero) &&
      corte.tramites.retrabajo.por_ingeniero.length)
    fugas.push({ ruta: 'tramites.retrabajo.por_ingeniero', motivo: 'retrabajo atribuido a personas' });

  return fugas;
}
