/* ---------------------------------------------------------------------------
 * mapeo-extra.mjs — trámites y Alimentia dentro del corte.
 *
 * Cada bloque devuelve null si su plataforma no respondió. El tablero lo
 * pinta como ausente, con el motivo, en vez de mostrar ceros que se leen
 * como "no pasó nada".
 * ------------------------------------------------------------------------- */
import { EMPRESAS_DEMO_ALIMENTIA } from './fuentes.mjs';

/** Trámites: lo que pide el bloque C sobre ingenieros. */
export function armarTramites(m) {
  const carga = m.tr_carga && m.tr_carga.datos;
  const tiempos = m.tr_tiempos && m.tr_tiempos.datos;
  const retrabajo = m.tr_retrabajo && m.tr_retrabajo.datos;
  const duracion = m.tr_duracion && m.tr_duracion.datos;
  if (!carga && !tiempos && !retrabajo && !duracion) return null;

  return {
    regla: (m.tr_carga || m.tr_tiempos || m.tr_retrabajo || m.tr_duracion).regla || null,
    generado_en: (m.tr_carga || m.tr_tiempos || m.tr_retrabajo || m.tr_duracion).generado_en || null,
    periodo: (carga || tiempos || retrabajo || duracion).periodo,
    ingenieros: carga ? {
      activos: carga.ingenieros_activos,
      con_carga: carga.ingenieros_con_carga ?? null,
      sin_carga: carga.ingenieros_sin_carga ?? null,
      carga_mediana: carga.carga_mediana,
      criterio_sobrecarga: carga.criterio_sobrecarga,
      /* La versión anterior del endpoint devolvía una lista de nombres; la
         actual, objetos con el número de trámites. El tablero no puede
         asumir cuál está desplegada, así que normaliza las dos. */
      sobrecargados: (carga.sobrecargados || []).map((x) =>
        typeof x === 'string' ? { nombre: x, solicitudes_abiertas: null } : x),
      /* Nueve de catorce en cero mientras otros se saturan es un problema de
         reparto, no de volumen, y no se ve en ningún promedio. */
      reparto_desigual: carga.reparto_desigual ?? null,
      detalle: (carga.detalle || []).slice().sort(
        (a, b) => b.solicitudes_abiertas - a.solicitudes_abiertas),
    } : null,
    etapas: tiempos ? {
      medidas: tiempos.etapas_medidas,
      cuello_de_botella: tiempos.cuello_de_botella,
      detalle: tiempos.detalle || [],
      atascadas: tiempos.abiertas_por_encima_de_su_mediana || [],
    } : null,
    retrabajo: retrabajo ? {
      eliminadas: retrabajo.etapas_eliminadas,
      iniciadas: retrabajo.etapas_iniciadas,
      tasa: retrabajo.tasa,
      por_etapa: retrabajo.por_etapa || [],
      por_ingeniero: retrabajo.por_ingeniero || [],
      nota: retrabajo.nota,
    } : null,
    duracion: duracion ? {
      cerrados: duracion.cerrados_en_el_periodo,
      abiertos: duracion.abiertos_hoy,
      dias_mediana: duracion.dias_mediana,
      dias_p75: duracion.dias_p75,
      dias_p90: duracion.dias_p90,
      /* Sin meta no hay cumplimiento: el esquema no guarda plazo por trámite
         y calcularlo exigiría inventar un objetivo. */
      cumplimiento: duracion.cumplimiento,
      nota_cumplimiento: duracion.nota_cumplimiento,
    } : null,
  };
}

/** Alimentia: uso diario por empresa, sin las de demostración. */
export function armarAlimentia(m) {
  const dil = m.al_diligenciamiento && m.al_diligenciamiento.datos;
  const caida = m.al_caida && m.al_caida.datos;
  if (!dil && !caida) return null;

  const real = (e) => !EMPRESAS_DEMO_ALIMENTIA.has(e.company_id);

  let empresas = [], esperados = 0, entregados = 0;
  if (dil) {
    empresas = (dil.detalle || []).filter(real);
    /* Los totales se recalculan sobre las empresas reales: los que trae el
       endpoint incluyen las de demostración e inflan el denominador. */
    esperados = empresas.reduce((a, e) => a + Number(e.esperados || 0), 0);
    entregados = empresas.reduce((a, e) => a + Number(e.entregados || 0), 0);
  }

  return {
    regla: (m.al_diligenciamiento || m.al_caida).regla || null,
    generado_en: (m.al_diligenciamiento || m.al_caida).generado_en || null,
    periodo: (dil || caida).periodo,
    dias_del_periodo: dil ? dil.dias_del_periodo : null,
    empresas: empresas.length,
    con_obligacion: empresas.filter((e) => e.esperados > 0).length,
    esperados,
    entregados,
    cumplimiento: esperados > 0 ? Math.round((entregados / esperados) * 10000) / 10000 : null,
    sin_un_solo_registro: empresas.filter((e) => e.esperados > 0 && e.entregados === 0).length,
    detalle: empresas.slice().sort((a, b) => (a.cumplimiento ?? 1) - (b.cumplimiento ?? 1)),
    cayendo: caida ? (caida.cayendo || []).filter(real) : [],
    detenidas: caida ? (caida.detenidas || []).filter(real) : [],
    comparado_contra: caida ? caida.comparado_contra : null,
    /* Definición abierta, heredada del endpoint: lo esperado cuenta los siete
       días de la semana, domingos y festivos incluidos. Eso hunde el
       cumplimiento de cualquier empresa que no opere a diario. Hay que
       decidirlo con la Dirección, no corregirlo por nuestra cuenta. */
    advertencia_definicion:
      'Lo esperado cuenta los siete días de la semana, incluidos domingos y festivos. ' +
      'Una empresa que no opera a diario aparecerá con cumplimiento bajo sin estarlo. ' +
      'Falta que la Dirección defina qué días son exigibles.',
    demo_excluidas: EMPRESAS_DEMO_ALIMENTIA.size,
  };
}
