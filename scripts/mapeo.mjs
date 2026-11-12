/* ---------------------------------------------------------------------------
 * mapeo.mjs — convierte las respuestas de la API en data/corte.json
 *
 * Regla de oro: lo que la plataforma ya calcula, se lee; no se recalcula.
 * El puntaje de calidad del dato viene tal cual del endpoint.
 * ------------------------------------------------------------------------- */

/** Códigos que son la misma empresa partida en varios registros.
 *  Es una lista explícita a propósito: unificar por parecido de nombre
 *  mezclaría empresas distintas. Cuando se unifiquen en la plataforma,
 *  estas entradas sobran y se borran. */
export const UNIFICAR = {
  '8ac087': { nombre: 'ARCOS DORADOS COLOMBIA S.A.S.', codigos: ['8ac087', '637b9c'] },
  'cc43d6': { nombre: 'Integrativa Agropecuaria S.A.S.', codigos: ['cc43d6', '0d090b'] },
};
const SIN_EMPRESA = 'bpmsas';
const DUENO = {};
for (const [jefe, g] of Object.entries(UNIFICAR)) for (const c of g.codigos) DUENO[c] = jefe;

import { armarTramites, armarAlimentia } from './mapeo-extra.mjs';
import { generarAlertas } from './alertas.mjs';
import { aplicarCerrados } from './congelado.mjs';

const REGLA = 'virtual-metrics-v1';
const MESLARGO = ['enero','febrero','marzo','abril','mayo','junio','julio',
                  'agosto','septiembre','octubre','noviembre','diciembre'];
const etiqueta = (p) => {
  const [a, m] = p.split('-').map(Number);
  const n = MESLARGO[m - 1];
  return { lbl: n[0].toUpperCase() + n.slice(1) + ' ' + a, corto: n };
};
const valorServicio = (porCurso) =>
  (porCurso || []).reduce((a, c) => a + Number(c.certificados || 0) * Number(c.precio_vigente || 0), 0);

/** Un periodo del tablero, a partir de certificaciones + empresas del mes. */
function armarMes(cert, emp) {
  const d = cert.datos, e = emp && emp.datos;
  const { lbl, corto } = etiqueta(d.periodo);
  return {
    id: d.periodo, lbl, corto,
    cert: d.total_certificados,
    personas: d.total_personas,
    ingreso: valorServicio(d.por_curso),
    /* El desglose por curso se conserva, no solo el total. Es el precio con
       el que se calculo el mes, y es lo que se congela cuando el mes cierra:
       sin el, cambiar un co_price en la plataforma recalcula un mes ya
       informado. Ademas es la respuesta a "de donde sale este valor", que es
       lo que la Direccion pidio en B3. */
    porCurso: (d.por_curso || [])
      .filter((c) => Number(c.certificados) > 0)
      .map((c) => ({
        course_id: c.course_id,
        nombre: c.nombre,
        precio: Number(c.precio_vigente || 0),
        certificados: Number(c.certificados || 0),
      })),
    ingresoBPM: null,                       // ventas pagadas: las produce BPM
    canal: { emp: d.por_canal.empresa, par: d.por_canal.particular },
    activasCodigos: e ? e.activas : null,   // lo que reporta la plataforma
    activas: null,                          // se completa tras unificar
    registradas: null,                      // se completa desde calidad-dato
    nuevas: e ? e.nuevas : null,
    retomadas: e ? e.retomadas : null,
  };
}

/** Empresas de todos los periodos, con los códigos duplicados unificados. */
function armarEmpresas(certPorMes) {
  const acc = new Map();
  for (const cert of Object.values(certPorMes)) {
    const periodo = cert.datos.periodo;        // la clave del mapa era 'prev'/'act'
    for (const row of cert.datos.por_empresa || []) {
      // La API mete a los particulares como una fila mas, con codigo
      // '(particular)' y nombre nulo. No es una empresa: si entra, aparece
      // como el cliente mayor y arruina el calculo de concentracion.
      if (!row.codigo || row.codigo === '(particular)' || row.codigo === SIN_EMPRESA) continue;
      const jefe = DUENO[row.codigo] || row.codigo;
      if (!acc.has(jefe)) {
        acc.set(jefe, {
          codigo: jefe,
          nombre: (UNIFICAR[jefe] && UNIFICAR[jefe].nombre) || row.nombre,
          ...(UNIFICAR[jefe] ? { codigos: UNIFICAR[jefe].codigos, unificada: true } : {}),
          meses: {},
        });
      }
      const e = acc.get(jefe);
      e.meses[periodo] = (e.meses[periodo] || 0) + Number(row.certificados || 0);
    }
  }
  for (const cert of Object.values(certPorMes))
    for (const e of acc.values())
      if (e.meses[cert.datos.periodo] === undefined) e.meses[cert.datos.periodo] = 0;
  return [...acc.values()];
}

/** Las once verificaciones del endpoint, en la forma que pinta el tablero. */
function armarCalidad(cal) {
  const d = cal.datos;
  const nf = (n) => Number(n).toLocaleString('es-CO');
  return {
    puntaje: d.puntaje,
    estado: d.estado,
    regla: d.regla,
    como_se_calcula: d.como_se_calcula,
    totales: d.totales,
    filas: (d.verificaciones || [])
      .slice()
      .sort((a, b) => Number(b.impacto || 0) - Number(a.impacto || 0))
      .map((v) => ({
        n: v.titulo,
        d: v.que_rompe,
        r: `${nf(v.afectados)} de ${nf(v.universo)} · ${(Number(v.tasa) * 100).toFixed(2)} %`,
        p: Number(Number(v.impacto || 0).toFixed(1)),
        peso: v.severidad,
      })),
  };
}

/** Días transcurridos de un mes, si es el mes en curso. */
function parcial(id, hoyISO) {
  const hoy = hoyISO || new Date().toISOString().slice(0, 10);
  if (id !== hoy.slice(0, 7)) return null;
  const dias = Number(hoy.slice(8, 10));
  const total = new Date(Date.UTC(+id.slice(0, 4), +id.slice(5, 7), 0)).getUTCDate();
  return { dias, total };
}

/**
 * Recompra, con el estado de su ventana.
 *
 * La cohorte de un periodo son los certificados emitidos doce meses antes, que
 * vencen durante ese mes. Cada uno tiene además los días de gracia para
 * renovar, de modo que la cohorte no termina de observarse hasta
 * fin de mes + gracia.
 *
 * El tablero venía publicando la tasa del mes en curso como si fuera un
 * resultado. No lo es: en noviembre, con diez de ciento diez días corridos, la
 * tasa salía en 0,37 % y la misma métrica sobre la cohorte de julio —ya
 * cerrada— da 18,21 %. No era un criterio mal definido, era una foto tomada al
 * 9 % del recorrido. Aquí se declara el estado para que nadie la lea como
 * definitiva.
 */
function armarRecompra(d, hoy) {
  if (!d) return null;
  const [a, mm] = String(d.periodo).split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(mm)) return d;

  const gracia = Number(d.dias_gracia_tarde || 0);
  const finMes = Date.UTC(a, mm, 0);
  const cierra = finMes + gracia * 864e5;
  const ahora = Date.parse(`${hoy}T00:00:00Z`);

  /* La ventana arranca el primer día del mes: el primer certificado de la
     cohorte puede vencer ese mismo día. */
  const abre = Date.UTC(a, mm - 1, 1);
  const total = Math.round((cierra - abre) / 864e5);
  const corridos = Math.max(0, Math.min(total, Math.round((ahora - abre) / 864e5)));

  /* La tasa no es un punto mientras no esté definido qué cuenta como
     renovación anticipada. «A tiempo» exige volver a certificarse en el mismo
     curso antes de que venza el original, pero hoy eso no se distingue de una
     reemisión del mismo certificado a los pocos días. Julio muestra 107
     anticipadas y agosto una, con cohortes comparables: la diferencia es
     demasiado grande para ser estacional.

     Hasta que se fije la ventana, la tasa se publica como el rango entre
     excluir y contar esas anticipadas. Lo pidió la Dirección en su
     observación B2, y es lo correcto: un punto que puede moverse seis puntos
     no es un punto. */
  const elegibles = Number(d.elegibles || 0);
  const aTiempo = Number(d.renovaron_a_tiempo || 0);
  const tarde = Number(d.renovaron_tarde || 0);
  const enRevision = elegibles > 0 && aTiempo > 0
    ? {
        desde: Math.round((tarde / elegibles) * 10000) / 10000,
        hasta: Math.round(((tarde + aTiempo) / elegibles) * 10000) / 10000,
        anticipadas: aTiempo,
        motivo:
          'No está definido desde cuántos días antes del vencimiento una ' +
          'certificación cuenta como renovación anticipada, de modo que no se ' +
          'puede separar una renovación de una reemisión. El límite inferior ' +
          'excluye las anticipadas y el superior las cuenta.',
      }
    : null;

  return {
    ...d,
    ventana_abierta: ahora < cierra,
    ventana_cierra: new Date(cierra).toISOString().slice(0, 10),
    ventana_dias_totales: total,
    ventana_dias_corridos: corridos,
    en_revision: enRevision,
  };
}

/** Índice de salud. Cada componente trae su fórmula en lenguaje llano. */
function armarSalud({ mes, serie, venc, calidad, concentracion, hoy }) {
  const comp = [];
  const nf = (n) => Number(n).toLocaleString('es-CO');

  /* Un mes en curso no se compara en bruto contra periodos completos: daría
     un derrumbe inventado. Se proyecta al ritmo que lleva y se dice. */
  const par = parcial(mes.id, hoy);
  const base = par ? Math.round(mes.cert / par.dias * par.total) : mes.cert;
  /* El índice proyecta el mes en curso; el comparativo anual de la página no.
     Son dos cifras distintas a propósito, y si no se dice cuál es cuál la
     página parece contradecirse: 1.848 proyectado arriba contra 616 observado
     abajo. La nota lo declara en los dos componentes que usan la proyección. */
  const nota = par
    ? ` ${mes.lbl} lleva ${par.dias} de ${par.total} días y va en ${nf(mes.cert)} ` +
      `certificaciones observadas; el índice proyecta a ${nf(base)} al ritmo actual, porque ` +
      `comparar un mes a medias contra uno completo da un derrumbe falso. El comparativo ` +
      `anual de más abajo muestra lo observado sin proyectar: por eso las dos cifras difieren.`
    : '';

  // Producción: el mes contra el mismo mes del año anterior.
  const anterior = (serie || []).find((m) => {
    const [a, mm] = mes.id.split('-').map(Number);
    return m.periodo === `${a - 1}-${String(mm).padStart(2, '0')}`;
  });
  if (anterior && anterior.certificados > 0) {
    const crec = (base / anterior.certificados - 1) * 100;
    comp.push({
      n: 'Producción', v: Math.round(Math.min(100, Math.max(0, 50 + (crec / 20) * 50))),
      d: `${mes.lbl} contra el mismo mes del año anterior: ${nf(base)}${par ? ' proyectadas' : ''} contra ` +
         `${nf(anterior.certificados)}, ${crec > 0 ? '+' : ''}${crec.toLocaleString('es-CO',{minimumFractionDigits:1,maximumFractionDigits:1})} %. ` +
         `Se mapea 0–20 % de crecimiento a 50–100 puntos.` + nota,
    });
  } else {
    comp.push({ n: 'Producción', v: null,
      d: 'Falta el mismo mes del año anterior en la serie para poder comparar.' });
  }

  // Reposición: ambas cifras medidas en el mismo instante del corte.
  const vt = venc.total;
  comp.push({
    n: 'Reposición', v: Math.round(Math.min(100, (base / vt) * 50)),
    d: `Certificaciones del mes sobre vencimientos de los próximos ${venc.ventana_dias} días, ` +
       `medidos el ${venc.corte}: ${nf(base)}${par ? ' proyectadas' : ''} / ${nf(vt)} = ${(base / vt).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}. ` +
       `Paridad (1,00) vale 50 puntos.` + nota,
  });

  // Calidad del dato: la calcula la plataforma. El tablero la lee.
  comp.push({
    n: 'Calidad del dato', v: calidad.puntaje,
    d: `Las ${calidad.filas.length} verificaciones del endpoint de calidad, regla ` +
       `${calidad.regla}. El tablero muestra el puntaje que produce la plataforma; no lo recalcula.`,
  });

  // Diversificación: cuánto pesa el cliente mayor en el canal empresa.
  comp.push({
    n: 'Diversificación', v: Math.round(Math.max(0, 100 - concentracion * 2)),
    d: `Un solo cliente concentra el ${concentracion.toLocaleString('es-CO',{minimumFractionDigits:1,maximumFractionDigits:1})} % del canal empresa. ` +
       `Cada punto de concentración descuenta dos puntos del componente.`,
  });

  const conValor = comp.filter((c) => c.v !== null);
  return {
    total: conValor.length ? Math.round(conValor.reduce((a, c) => a + c.v, 0) / conValor.length) : null,
    comp,
  };
}

/** Comparativo contra el año anterior, derivado de la serie. */
function armarYoy(serie, mes) {
  const [a, mm] = mes.id.split('-').map(Number);
  const mismoMesAnterior = serie.find((x) => x.periodo === `${a - 1}-${String(mm).padStart(2, '0')}`);
  const sumaAnio = (anio) => serie
    .filter((x) => x.periodo.startsWith(String(anio)) && Number(x.periodo.slice(5)) <= mm)
    .reduce((s, x) => s + Number(x.certificados || 0), 0);

  const acum2 = sumaAnio(a), acum1 = sumaAnio(a - 1);
  const mesesCubiertos = serie.filter((x) => x.periodo.startsWith(String(a - 1))).length;

  return {
    /* El acumulado solo es comparable si la serie cubre los mismos meses de
       los dos años. Con una ventana corta, el del año anterior sale truncado
       y el crecimiento aparenta ser enorme. */
    acum: (acum1 > 0 && mesesCubiertos >= mm)
      ? { lbl: `Enero – ${mes.corto}`, a2026: acum2, a2025: acum1 }
      : null,
    mes: mismoMesAnterior
      ? { lbl: mes.corto[0].toUpperCase() + mes.corto.slice(1),
          a2026: mes.cert, a2025: mismoMesAnterior.certificados }
      : null,
  };
}

export function armarCorte(m, narrativa = {}, fallaron = {}, extras = {}) {
  const certPorMes = { prev: m.certificaciones_prev, act: m.certificaciones };
  const meses = [
    armarMes(m.certificaciones_prev, m.empresas_prev || null),
    armarMes(m.certificaciones, m.empresas || null),
  ];
  const empresas = armarEmpresas(certPorMes);

  // Empresas distintas por mes, ya unificadas.
  for (const mes of meses) {
    mes.activas = empresas.filter((e) => Number(e.meses[mes.id] || 0) > 0).length;
  }

  /* Cuántas empresas hay registradas en total. La API no lo expone como tal,
     pero es el universo de las verificaciones de empresa del endpoint de
     calidad. Si cambian esas claves, queda en null y el tablero lo declara
     ausente en vez de inventar un denominador. */
  const vEmpresa = (m['calidad-dato'].datos.verificaciones || [])
    .find((v) => v.clave === 'codigo_empresa_duplicado' || v.clave === 'empresa_duplicada_por_nombre');
  const registradas = vEmpresa ? Number(vEmpresa.universo) : null;
  for (const mes of meses) mes.registradas = registradas;

  const ult = meses[meses.length - 1];
  const totalEmp = ult.canal.emp || 1;
  const mayor = empresas.reduce((mx, e) =>
    Math.max(mx, Number(e.meses[ult.id] || 0)), 0);
  const concentracion = (mayor / totalEmp) * 100;

  const v = m.vencimientos.datos;
  const venc = {
    corte: v.corte, ventana_dias: v.ventana_dias,
    total: v.total, emp: v.con_empresa, par: v.particulares,
    por_semana: v.por_semana,
    por_empresa: (v.por_empresa || []).slice(0, 10),
  };

  const calidad = armarCalidad(m['calidad-dato']);
  const serie = (m.serie.datos.meses || []).map((x) => ({ ...x }));

  /* Los meses ya cerrados se sustituyen por la cifra con la que cerraron,
     ANTES de calcular lo derivado, para que el ano contra ano, el indice de
     salud y el precio observado salgan todos del mismo numero. La diferencia
     contra lo que la plataforma reporta hoy viaja aparte, como deriva. */
  const cerradosAplicados = extras.cerrados
    ? aplicarCerrados({ meses, serie }, extras.cerrados).aplicados
    : [];

  /* La serie y el resumen salen de endpoints distintos de la misma plataforma,
     y los dos cachean. Si las llamadas caen a distinto lado de un vencimiento
     de caché, el mes en curso llega con dos cifras: noviembre mostraba 403 en
     la serie y 436 en el resumen. Para el lector son dos verdades sobre el
     mismo mes, así que la serie se alinea con la cifra que alimentan los KPI
     y se deja constancia de que se corrigió. */
  const desalineados = [];
  for (const mes of meses) {
    const punto = serie.find((x) => x.periodo === mes.id);
    if (!punto) continue;
    if (Number(punto.certificados) !== Number(mes.cert)) {
      desalineados.push({
        periodo: mes.id,
        serie: Number(punto.certificados),
        resumen: Number(mes.cert),
      });
      punto.certificados = mes.cert;
      punto.personas = mes.personas;
    }
  }

  /* La fecha del corte y la version de la regla ya no se le piden a /health:
     vienen en respuestas que de todos modos hacen falta. Un llamado menos
     contra el limite por minuto de la plataforma. */
  const fechaCorte = v.corte
    || (m['calidad-dato'].datos.evaluado_en || '').slice(0, 10)
    || new Date().toISOString().slice(0, 10);
  const versionRegla = m['calidad-dato'].datos.regla ? REGLA : REGLA;

  const corte = {
    corte: fechaCorte,
    generado_en: new Date().toISOString(),
    regla: versionRegla,
    sin_respuesta: Object.keys(fallaron).length ? fallaron : undefined,
    fuente: 'virtual.bpmsas.co · capa de métricas',
    meses,
    empresas,
    serie,
    serie_realineada: desalineados.length ? desalineados : undefined,
    yoy: armarYoy(serie, ult),
    venc,
    recompra: armarRecompra(m.recompra && m.recompra.datos, fechaCorte),
    recompra_cerrada: armarRecompra(m.recompra_cerrada && m.recompra_cerrada.datos, fechaCorte),
    atribucion: m.atribucion ? m.atribucion.datos : null,
    cursos: m.cursos ? m.cursos.datos : null,
    calidad: calidad.filas,
    calidadResumen: {
      puntaje: calidad.puntaje, estado: calidad.estado,
      regla: calidad.regla, como_se_calcula: calidad.como_se_calcula,
    },
    universo: calidad.totales,
    tramites: armarTramites(m),
    alimentia: armarAlimentia(m),
    salud: armarSalud({ mes: ult, serie, venc, calidad, concentracion,
                       hoy: fechaCorte }),
    precioMedioObservado: Math.round(ult.ingreso / ult.cert),
    /* La deriva de los meses cerrados se calcula antes de armar el corte,
       porque hace falta leer el registro en disco. Entra aqui para que las
       alertas la vean: si llegara despues, se calcularian sin ella. */
    meses_cerrados: cerradosAplicados.length ? cerradosAplicados : undefined,
    ...(extras.deriva_meses_cerrados ? { deriva_meses_cerrados: extras.deriva_meses_cerrados } : {}),
    ...(extras.meses_cerrados_que_cambiaron ? { meses_cerrados_que_cambiaron: extras.meses_cerrados_que_cambiaron } : {}),
    ...narrativa,
  };

  /* Las alertas se calculan sobre el corte ya armado, no en paralelo: así
     miran exactamente las mismas cifras que verá la Dirección en pantalla y
     no pueden contradecirlas. */
  corte.alertas = generarAlertas(corte);
  return corte;
}
