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
    ingresoBPM: null,                       // ventas pagadas: las produce BPM
    canal: { emp: d.por_canal.empresa, par: d.por_canal.particular },
    activasCodigos: e ? e.activas : null,   // lo que reporta la plataforma
    activas: null,                          // se completa tras unificar
    registradas: null,
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

/** Índice de salud. Cada componente trae su fórmula en lenguaje llano. */
function armarSalud({ mes, serie, venc, calidad, concentracion }) {
  const comp = [];
  const nf = (n) => Number(n).toLocaleString('es-CO');

  // Producción: el mes contra el mismo mes del año anterior.
  const anterior = (serie || []).find((m) => {
    const [a, mm] = mes.id.split('-').map(Number);
    return m.periodo === `${a - 1}-${String(mm).padStart(2, '0')}`;
  });
  if (anterior && anterior.certificados > 0) {
    const crec = (mes.cert / anterior.certificados - 1) * 100;
    comp.push({
      n: 'Producción', v: Math.round(Math.min(100, Math.max(0, 50 + (crec / 20) * 50))),
      d: `${mes.lbl} contra el mismo mes del año anterior: ${nf(mes.cert)} contra ` +
         `${nf(anterior.certificados)}, ${crec > 0 ? '+' : ''}${crec.toFixed(1)} %. ` +
         `Se mapea 0–20 % de crecimiento a 50–100 puntos.`,
    });
  } else {
    comp.push({ n: 'Producción', v: null,
      d: 'Falta el mismo mes del año anterior en la serie para poder comparar.' });
  }

  // Reposición: ambas cifras medidas en el mismo instante del corte.
  const vt = venc.total;
  comp.push({
    n: 'Reposición', v: Math.round(Math.min(100, (mes.cert / vt) * 50)),
    d: `Certificaciones del mes sobre vencimientos de los próximos ${venc.ventana_dias} días, ` +
       `medidos el ${venc.corte}: ${nf(mes.cert)} / ${nf(vt)} = ${(mes.cert / vt).toFixed(2)}. ` +
       `Paridad (1,00) vale 50 puntos.`,
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
    d: `Un solo cliente concentra el ${concentracion.toFixed(1)} % del canal empresa. ` +
       `Cada punto de concentración descuenta dos puntos del componente.`,
  });

  const conValor = comp.filter((c) => c.v !== null);
  return {
    total: conValor.length ? Math.round(conValor.reduce((a, c) => a + c.v, 0) / conValor.length) : null,
    comp,
  };
}

export function armarCorte(m, narrativa = {}) {
  const certPorMes = { prev: m.certificaciones_prev, act: m.certificaciones };
  const meses = [
    armarMes(m.certificaciones_prev, m.empresas_prev),
    armarMes(m.certificaciones, m.empresas),
  ];
  const empresas = armarEmpresas(certPorMes);

  // Empresas distintas por mes, ya unificadas.
  for (const mes of meses) {
    mes.activas = empresas.filter((e) => Number(e.meses[mes.id] || 0) > 0).length;
  }

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
  const serie = m.serie.datos.meses;

  return {
    corte: (m.health.datos.ultima_certificacion) || new Date().toISOString().slice(0, 10),
    generado_en: new Date().toISOString(),
    regla: m.health.datos.version_reglas,
    fuente: 'virtual.bpmsas.co · capa de métricas',
    meses,
    empresas,
    serie,
    venc,
    recompra: m.recompra.datos,
    atribucion: m.atribucion.datos,
    cursos: m.cursos.datos,
    calidad: calidad.filas,
    calidadResumen: {
      puntaje: calidad.puntaje, estado: calidad.estado,
      regla: calidad.regla, como_se_calcula: calidad.como_se_calcula,
    },
    universo: calidad.totales,
    salud: armarSalud({ mes: ult, serie, venc, calidad, concentracion }),
    precioMedioObservado: Math.round(ult.ingreso / ult.cert),
    ...narrativa,
  };
}
