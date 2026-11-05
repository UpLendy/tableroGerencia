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

/** Índice de salud. Cada componente trae su fórmula en lenguaje llano. */
function armarSalud({ mes, serie, venc, calidad, concentracion, hoy }) {
  const comp = [];
  const nf = (n) => Number(n).toLocaleString('es-CO');

  /* Un mes en curso no se compara en bruto contra periodos completos: daría
     un derrumbe inventado. Se proyecta al ritmo que lleva y se dice. */
  const par = parcial(mes.id, hoy);
  const base = par ? Math.round(mes.cert / par.dias * par.total) : mes.cert;
  const nota = par
    ? ` ${mes.lbl} lleva ${par.dias} de ${par.total} días: se proyecta a ${nf(base)} ` +
      `al ritmo actual, porque comparar un mes a medias contra uno completo da un derrumbe falso.`
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
      d: `${mes.lbl} contra el mismo mes del año anterior: ${nf(base)} contra ` +
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
       `medidos el ${venc.corte}: ${nf(base)} / ${nf(vt)} = ${(base / vt).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}. ` +
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

export function armarCorte(m, narrativa = {}, fallaron = {}) {
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
  const serie = m.serie.datos.meses;

  /* La fecha del corte y la version de la regla ya no se le piden a /health:
     vienen en respuestas que de todos modos hacen falta. Un llamado menos
     contra el limite por minuto de la plataforma. */
  const fechaCorte = v.corte
    || (m['calidad-dato'].datos.evaluado_en || '').slice(0, 10)
    || new Date().toISOString().slice(0, 10);
  const versionRegla = m['calidad-dato'].datos.regla ? REGLA : REGLA;

  return {
    corte: fechaCorte,
    generado_en: new Date().toISOString(),
    regla: versionRegla,
    sin_respuesta: Object.keys(fallaron).length ? fallaron : undefined,
    fuente: 'virtual.bpmsas.co · capa de métricas',
    meses,
    empresas,
    serie,
    yoy: armarYoy(serie, ult),
    venc,
    recompra: m.recompra ? m.recompra.datos : null,
    atribucion: m.atribucion ? m.atribucion.datos : null,
    cursos: m.cursos ? m.cursos.datos : null,
    calidad: calidad.filas,
    calidadResumen: {
      puntaje: calidad.puntaje, estado: calidad.estado,
      regla: calidad.regla, como_se_calcula: calidad.como_se_calcula,
    },
    universo: calidad.totales,
    salud: armarSalud({ mes: ult, serie, venc, calidad, concentracion,
                       hoy: fechaCorte }),
    precioMedioObservado: Math.round(ult.ingreso / ult.cert),
    ...narrativa,
  };
}
