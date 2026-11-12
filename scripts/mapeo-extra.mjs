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

      /* La carga cuenta solicitudes INVIMA y nada más, pero los ingenieros
         hacen dos trabajos: trámites y visitas en sitio. Mariana Lopez
         aparece en cero trámites con nueve citas en el periodo, y Luisa
         Garcia con 18 trámites y ninguna cita. Leer «0» como ocioso es
         falso, así que el tablero declara qué mide y cuántos de los que
         figuran sin carga sí tienen visitas. Quién cuenta como sobrecargado
         lo decide la Dirección, no nosotros. */
      que_mide_la_carga:
        'Solicitudes INVIMA abiertas. No incluye visitas en sitio ' +
        '—asesorías, auditorías, seguimientos, capacitaciones—, que la ' +
        'plataforma registra como citas y no como carga.',
      sin_carga_con_citas: (carga.detalle || [])
        .filter((f) => Number(f.solicitudes_abiertas || 0) === 0 &&
                       Number(f.citas_periodo || 0) > 0).length,
      citas_periodo_total: (carga.detalle || [])
        .reduce((a, f) => a + Number(f.citas_periodo || 0), 0),
    } : null,
    etapas: tiempos ? {
      medidas: tiempos.etapas_medidas,
      cuello_de_botella: tiempos.cuello_de_botella,
      atascadas: tiempos.atascadas || tiempos.abiertas_por_encima_de_su_mediana || [],
      /* Un trámite sin ingeniero asignado y uno asignado que va lento no son
         el mismo problema: reparto contra ejecución. El endpoint ya los
         separa; el tablero los estaba volviendo a juntar al descartarlos. */
      sin_asignar: tiempos.sin_asignar || [],
      sin_asignar_total: tiempos.sin_asignar_total ?? null,
      dias_del_mas_viejo_sin_asignar: tiempos.dias_del_mas_viejo_sin_asignar ?? null,
      /* Hay etapas que se abren y se cierran en el mismo instante: su fecha
         de cierre registra cuándo alguien marcó la casilla, no cuánto duró la
         gestión. Mezclarlas con las demás en un ranking de lentitud compara
         cosas que no son comparables.

         Dos casos distintos. «No registra»: mediana, promedio y máximo en
         cero, o sea que ningún trámite dejó rastro de duración. «Registro
         mixto»: mediana en cero pero con máximos de meses, o sea que más de
         la mitad se cerraron al instante y unos pocos sí se midieron; su
         mediana no significa «rápido», significa «no anotado». */
      detalle: (tiempos.detalle || []).map((e) => {
        const med = Number(e.dias_mediana || 0);
        const prom = Number(e.dias_promedio || 0);
        const max = Number(e.dias_max || 0);
        return {
          ...e,
          no_registra: med === 0 && prom === 0 && max === 0,
          registro_mixto: med === 0 && max > 0,
        };
      }),
      /* Cuántas de las medidas sirven de verdad para hablar de tiempos. */
      etapas_sin_registro: (tiempos.detalle || []).filter((e) =>
        Number(e.dias_mediana || 0) === 0 && Number(e.dias_promedio || 0) === 0 &&
        Number(e.dias_max || 0) === 0).length,
      etapas_con_duracion_real: (tiempos.detalle || []).filter((e) =>
        Number(e.dias_mediana || 0) > 0).length,
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
      /* La Dirección decidió el 11 de noviembre que NO habrá meta en días
         para los trámites: son ocasionales y no se miden contra un plazo
         fijo. El indicador no se calcula y no entra en el corte. Se deja
         dicho aquí para que nadie lo vuelva a agregar por iniciativa propia.
         La meta de BPM es la meta mensual de ventas, que es otro indicador. */
    } : null,
  };
}

/**
 * Empresas detenidas, con el criterio de la plataforma pero solo sobre las
 * empresas reales. Las que nunca empezaron van primero: no arrancar es un
 * problema de puesta en marcha y dejar de hacerlo es de abandono.
 */
function derivarDetenidas(empresas, dil) {
  const hasta = (dil && dil.hasta) || null;
  const dias = (f) => {
    if (!f || !hasta) return null;
    const ms = Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`);
    return ms < 0 ? 0 : Math.round(ms / 86400000);
  };
  return empresas
    .filter((e) => Number(e.esperados || 0) > 0)
    .map((e) => ({
      company_id: e.company_id,
      nombre: e.nombre,
      nit: e.nit,
      cumplimiento: e.cumplimiento,
      entregados: e.entregados,
      ultimo_diligenciamiento: e.ultimo_diligenciamiento ?? null,
      dias_sin_diligenciar: dias(e.ultimo_diligenciamiento),
      nunca_empezo: e.ultimo_diligenciamiento == null,
    }))
    .filter((e) => e.nunca_empezo || (e.dias_sin_diligenciar ?? 0) >= 7)
    .sort((a, b) => {
      if (a.nunca_empezo !== b.nunca_empezo) return a.nunca_empezo ? -1 : 1;
      return (b.dias_sin_diligenciar ?? 0) - (a.dias_sin_diligenciar ?? 0);
    });
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

    /* Detenidas se deriva aquí, no se toma del endpoint, por la misma razón
       por la que se recalculan los totales: la plataforma no sabe cuáles de
       sus empresas son de demostración, así que su lista mezcla las tres de
       prueba con las reales. El criterio es el de la plataforma —nunca
       diligenció, o siete días o más sin hacerlo— aplicado solo a las reales.

       Además hoy la lista del endpoint llega vacía teniendo CÁRNICOS EL HATO
       en «nunca», que es justo el caso que la Dirección reportó. Derivarla
       aquí hace que el tablero muestre el dato correcto, y la discrepancia
       queda contada en detenidas_endpoint para que no se pierda de vista. */
    detenidas: derivarDetenidas(empresas, dil),
    detenidas_endpoint: caida ? (caida.detenidas || []).filter(real).length : null,
    nunca_han_diligenciado: empresas.filter((e) => e.ultimo_diligenciamiento == null).length,
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
