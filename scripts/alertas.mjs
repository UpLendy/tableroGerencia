/* ---------------------------------------------------------------------------
 * alertas.mjs — qué tiene que llegarle a alguien sin que abra el tablero.
 *
 * Bloque D de COT-2026-TABLERO-01: «motor de alertas sobre umbrales y
 * patrones». Un tablero que hay que acordarse de abrir no avisa de nada; lo
 * que cambia la operación es que la alerta salga a buscar a la persona.
 *
 * Cada alerta trae:
 *
 *   id          estable entre cortes. Es lo que permite que el envío a Trello
 *               no cree una tarjeta nueva cada noche por el mismo problema.
 *   severidad   'critica' | 'atencion' | 'aviso'.
 *   para        'gerencia' si menciona dinero o señala a una persona; 'todos'
 *               si es operativa. Con las vistas separadas, una alerta que
 *               nombra pesos no puede llegarle al equipo.
 *   accion      qué hacer. Una alerta sin acción es ruido con formato.
 *
 * Los umbrales van declarados y en un solo sitio: discutirlos con la Dirección
 * es parte del trabajo, y para eso tienen que poder leerse sin abrir el código.
 * ------------------------------------------------------------------------- */

export const UMBRALES = {
  saludCritica: 50,
  saludAtencion: 70,
  calidadCritica: 60,
  calidadAtencion: 80,
  concentracionAlta: 30,          // % del canal empresa en un solo cliente
  cumplimientoBajo: 50,           // % de diligenciamiento de Alimentia
  diasSinAsignar: 30,             // trámite abierto sin ingeniero
  caidaEmpresa: 50,               // % de caída contra el mes anterior
  minimoParaCaida: 20,            // no se avisa por una empresa de 3 certificados
  vencimientosSemana: 300,        // concentración en una sola semana
  ritmoCaida: 10,                 // % de caída del ritmo diario
  carteraVencida: 25,             // % del total por cobrar con más de 90 días
  carteraVencidaGrave: 40,
  carteraConcentracion: 30,       // % de lo que se debe, en un solo cliente
  carteraConcentracionGrave: 45,
  certSinFacturar: 30,            // certificaciones del mes cerrado sin factura
  certSinFacturarGrave: 150,
  empresasSinNit: 5,              // empresas que el cruce no puede resolver
  /* La lectura de Siigo corre una vez al día. Treinta horas es una corrida
     perdida contando el margen de que se retrase; cincuenta y cuatro son
     dos, y entonces ya no es un tropiezo sino que algo está roto. */
  datoViejoHoras: 30,
  datoMuyViejoHoras: 54,
};

const nf = (n) => Number(n).toLocaleString('es-CO');
const cop = (n) => '$' + Number(Math.round(n)).toLocaleString('es-CO');
const pc = (n) =>
  Number(n).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';

/** Días del mes de un periodo YYYY-MM. */
const diasDe = (id) => new Date(Date.UTC(+id.slice(0, 4), +id.slice(5, 7), 0)).getUTCDate();

export function generarAlertas(c, umbrales = {}) {
  const U = { ...UMBRALES, ...umbrales };
  const A = [];
  const añadir = (a) => A.push({ para: 'todos', ...a });

  if (!c || !Array.isArray(c.meses) || !c.meses.length) return A;

  const mes = c.meses[c.meses.length - 1];
  const prev = c.meses.length > 1 ? c.meses[c.meses.length - 2] : null;
  const corte = String(c.corte || '');
  const esParcial = mes.id === corte.slice(0, 7);
  const diaCorte = Number(corte.slice(8, 10)) || diasDe(mes.id);

  /* --------------------------------------------- un mes cerrado se movió
     Observación A1 de la Dirección, con la causa ya establecida. La cifra de
     un mes cerrado se mueve por dos rutas del código de la plataforma:

       · renovar un curso reutiliza el registro del certificado anterior y le
         sobre-escribe cert_date, así que el certificado se muda de mes;
       · asignar un código de empresa sobre-escribe el cert_date de todos los
         cursos activos de esa persona con la fecha de la asignación.

     Ninguna de las dos es un error de alguien dando de baja un registro, que
     es lo que esta alerta decía antes. El tablero muestra la cifra que se
     congeló al cerrar el mes; esto informa cuánto se ha movido desde entonces
     y por qué, para que la diferencia sea auditable en vez de invisible. */
  const mc = c.deriva_meses_cerrados || c.meses_cerrados_que_cambiaron;
  if (mc && Array.isArray(mc.cambios) && mc.cambios.length) {
    const unidad = { cert: 'certificaciones', personas: 'personas', ingreso: 'el valor' };
    for (const x of mc.cambios) {
      /* Los dos nombres de campo conviven: 'cerrado'/'ahora' es el registro
         congelado, 'antes'/'despues' el formato anterior. */
      const antes = Number(x.cerrado ?? x.antes);
      const ahora = Number(x.ahora ?? x.despues);
      const esDinero = x.campo === 'ingreso';
      const fmt = esDinero ? cop : nf;
      añadir({
        id: `mes-cerrado-deriva-${x.periodo}-${x.campo}-${ahora}`,
        severidad: Math.abs(x.diferencia) > 5 ? 'critica' : 'atencion',
        para: esDinero ? 'gerencia' : 'todos',
        titulo: `${x.periodo} se cerró con ${fmt(antes)} y la plataforma hoy reporta ${fmt(ahora)}`,
        detalle: `Se movió ${x.diferencia > 0 ? '+' : ''}${fmt(Math.abs(x.diferencia))} en ` +
                 `${unidad[x.campo] || x.campo}` +
                 (x.cerrado_en ? `, desde que el mes se cerró el ${x.cerrado_en}.` : '.') +
                 ' El tablero sigue mostrando la cifra cerrada. La causa habitual es una ' +
                 'renovación: el certificado anterior cambia de fecha y se muda de mes.',
        cifra: x.diferencia,
        seccion: 'volumen',
        accion: x.diferencia < 0
          ? 'Confirmar que son renovaciones; si no lo son, buscar el registro que salió.'
          : 'Confirmar qué registros entraron a un mes que ya estaba informado.',
      });
    }
  }

  /* ------------------------------------------------------------- salud */
  if (c.salud && Number.isFinite(Number(c.salud.total))) {
    const v = Number(c.salud.total);
    if (v < U.saludAtencion) {
      const flojos = (c.salud.comp || [])
        .filter((x) => Number.isFinite(Number(x.v)) && Number(x.v) < 50)
        .map((x) => x.n);
      añadir({
        id: `salud-${mes.id}`,
        severidad: v < U.saludCritica ? 'critica' : 'atencion',
        titulo: `Índice de salud en ${nf(v)} de 100`,
        detalle: flojos.length
          ? `Lo que más pesa: ${flojos.join(', ')}.`
          : 'Ningún componente por debajo de 50, pero el promedio está bajo.',
        cifra: v,
        seccion: 'salud',
        accion: 'Revisar en la reunión qué componente se puede mover este mes.',
      });
    }
  }

  /* ------------------------------------------------------- calidad del dato */
  const q = c.calidadResumen;
  if (q && Number.isFinite(Number(q.puntaje)) && Number(q.puntaje) < U.calidadAtencion) {
    const peor = Object.values(c.calidad || {})
      .filter((x) => Number(x.p) > 0)
      .sort((a, b) => Number(b.p) - Number(a.p))[0];
    añadir({
      id: `calidad-${mes.id}`,
      severidad: Number(q.puntaje) < U.calidadCritica ? 'critica' : 'atencion',
      titulo: `Calidad del dato en ${nf(q.puntaje)} de 100`,
      detalle: peor ? `Lo que más descuenta: ${peor.n} (${peor.r}).` : '',
      cifra: Number(q.puntaje),
      seccion: 'calidad',
      accion: 'Corregir en la plataforma de origen; el tablero solo lo reporta.',
    });
  }

  /* ------------------------------------------------------- ritmo del mes */
  if (prev && esParcial && diaCorte > 3) {
    const ritmo = mes.cert / diaCorte;
    const ritmoPrev = prev.cert / diasDe(prev.id);
    if (ritmoPrev > 0) {
      const dif = (ritmo / ritmoPrev - 1) * 100;
      if (dif < -U.ritmoCaida) {
        añadir({
          id: `ritmo-${mes.id}`,
          severidad: dif < -25 ? 'critica' : 'atencion',
          titulo: `El ritmo de ${mes.corto} va ${pc(Math.abs(dif))} por debajo de ${prev.corto}`,
          detalle: `${ritmo.toFixed(1)} certificaciones por día contra ${ritmoPrev.toFixed(1)}. ` +
                   `Comparación por ritmo diario, no por total: ${mes.corto} lleva ${diaCorte} de ${diasDe(mes.id)} días.`,
          cifra: Number(dif.toFixed(1)),
          seccion: 'volumen',
          accion: 'Mirar qué empresas dejaron de certificar en la cartera.',
        });
      }
    }
  }

  /* ---------------------------------------------------------- vencimientos */
  if (c.venc && Number(c.venc.total) > 0) {
    const v = c.venc;
    añadir({
      id: `vencimientos-${mes.id}`,
      severidad: 'atencion',
      titulo: `${nf(v.total)} certificados vencen en los próximos ${nf(v.ventana_dias)} días`,
      detalle: `${nf(v.emp)} vinculados a empresa, que se contactan en bloque, y ${nf(v.par)} ` +
               `particulares, que son uno a uno.`,
      cifra: Number(v.total),
      seccion: 'vencimientos',
      accion: 'Lanzar el contacto del canal corporativo antes de que venzan.',
    });

    /* El valor es de Gerencia: menciona pesos. */
    if (c.precioMedioObservado) {
      añadir({
        id: `vencimientos-valor-${mes.id}`,
        severidad: 'aviso',
        para: 'gerencia',
        titulo: `La recompra en juego vale ${cop(v.total * c.precioMedioObservado)}`,
        detalle: `A precio observado de ${cop(c.precioMedioObservado)} por certificación.`,
        cifra: Math.round(v.total * c.precioMedioObservado),
        seccion: 'vencimientos',
        accion: 'Decidir si se prioriza el canal corporativo o el particular.',
      });
    }

    const pico = (v.por_semana || []).slice().sort((a, b) => b.vencen - a.vencen)[0];
    if (pico && Number(pico.vencen) >= U.vencimientosSemana) {
      añadir({
        id: `vencimientos-pico-${mes.id}-${pico.semana}`,
        severidad: 'atencion',
        titulo: `${nf(pico.vencen)} vencimientos concentrados en la semana ${pico.semana}`,
        detalle: `Es el ${pc(pico.vencen / v.total * 100)} de toda la cola en una sola semana.`,
        cifra: Number(pico.vencen),
        seccion: 'vencimientos',
        accion: 'Preparar la capacidad de esa semana con anticipación.',
      });
    }
  }

  /* ------------------------------------------------------------- empresas */
  if (prev && Array.isArray(c.empresas)) {
    const dejaron = [];
    const cayeron = [];
    for (const e of c.empresas) {
      const ahora = Number((e.meses || {})[mes.id] || 0);
      const antes = Number((e.meses || {})[prev.id] || 0);
      if (antes < U.minimoParaCaida) continue;
      if (ahora === 0) { dejaron.push({ n: e.nombre, antes }); continue; }
      /* En un mes parcial se compara el ritmo, no el acumulado. */
      const caida = esParcial
        ? ((ahora / diaCorte) / (antes / diasDe(prev.id)) - 1) * 100
        : (ahora / antes - 1) * 100;
      if (caida < -U.caidaEmpresa) cayeron.push({ n: e.nombre, antes, ahora, caida });
    }

    if (dejaron.length) {
      dejaron.sort((a, b) => b.antes - a.antes);
      añadir({
        id: `empresas-dejaron-${mes.id}`,
        severidad: dejaron.length > 3 ? 'critica' : 'atencion',
        titulo: `${nf(dejaron.length)} empresa${dejaron.length === 1 ? '' : 's'} dejó de certificar`,
        detalle: dejaron.slice(0, 5).map((d) => `${d.n} (tenía ${nf(d.antes)})`).join('; ') +
                 (dejaron.length > 5 ? `; y ${nf(dejaron.length - 5)} más.` : '.'),
        cifra: dejaron.length,
        seccion: 'empresas',
        accion: 'Contactar al responsable comercial de cada una.',
      });
    }

    for (const e of cayeron.sort((a, b) => a.caida - b.caida).slice(0, 3)) {
      añadir({
        id: `empresa-caida-${mes.id}-${e.n.replace(/\W+/g, '-').toLowerCase().slice(0, 40)}`,
        severidad: 'atencion',
        titulo: `${e.n} cayó ${pc(Math.abs(e.caida))}`,
        detalle: `${nf(e.antes)} en ${prev.corto} contra ${nf(e.ahora)} en ${mes.corto}` +
                 (esParcial ? ', comparado por ritmo diario.' : '.'),
        cifra: Number(e.caida.toFixed(1)),
        seccion: 'empresas',
        accion: 'Averiguar si es estacional o si se fueron.',
      });
    }
  }

  /* -------------------------------------------------------- concentración */
  if (Array.isArray(c.empresas) && mes.canal && mes.canal.emp > 0) {
    const mayor = c.empresas
      .map((e) => ({ n: e.nombre, v: Number((e.meses || {})[mes.id] || 0) }))
      .sort((a, b) => b.v - a.v)[0];
    if (mayor && mayor.v > 0) {
      const share = mayor.v / mes.canal.emp * 100;
      if (share >= U.concentracionAlta) {
        añadir({
          id: `concentracion-${mes.id}`,
          severidad: share >= 45 ? 'critica' : 'atencion',
          titulo: `${mayor.n} concentra el ${pc(share)} del canal empresa`,
          detalle: 'Perder ese cliente se siente de inmediato en el mes.',
          cifra: Number(share.toFixed(1)),
          seccion: 'empresas',
          accion: 'Revisar el plan de diversificación con la Dirección.',
        });
      }
    }
  }

  /* -------------------------------------------------------------- trámites */
  const t = c.tramites;
  if (t) {
    const e = t.etapas;
    if (e && Number(e.sin_asignar_total) > 0 &&
        Number(e.dias_del_mas_viejo_sin_asignar) >= U.diasSinAsignar) {
      añadir({
        id: `tramites-sin-asignar-${t.periodo}`,
        severidad: Number(e.dias_del_mas_viejo_sin_asignar) >= 90 ? 'critica' : 'atencion',
        titulo: `${nf(e.sin_asignar_total)} trámite${e.sin_asignar_total === 1 ? '' : 's'} sin ingeniero asignado`,
        detalle: `El más viejo lleva ${nf(e.dias_del_mas_viejo_sin_asignar)} días. ` +
                 'Es un problema de reparto, no de ejecución.',
        cifra: Number(e.sin_asignar_total),
        seccion: 'tramites',
        accion: 'Asignar responsable; nadie los está mirando.',
      });
    }

    const i = t.ingenieros;
    const cuantos = Array.isArray(i?.sobrecargados) ? i.sobrecargados.length : i?.sobrecargados_total;
    if (Number(cuantos) > 0) {
      /* Nombra personas: es de Gerencia. */
      añadir({
        id: `tramites-sobrecarga-${t.periodo}`,
        severidad: 'atencion',
        para: 'gerencia',
        titulo: `${nf(cuantos)} ingeniero${cuantos === 1 ? '' : 's'} por encima del criterio de carga`,
        detalle: (Array.isArray(i.sobrecargados) ? i.sobrecargados : [])
          .map((x) => `${x.nombre} (${nf(x.solicitudes_abiertas)})`).join(', ') +
          '. La carga cuenta solo trámites INVIMA, no visitas en sitio.',
        cifra: Number(cuantos),
        seccion: 'tramites',
        accion: 'Redistribuir, o confirmar que las visitas compensan.',
      });
    }
  }

  /* ------------------------------------------------------------- Alimentia */
  const al = c.alimentia;
  if (al) {
    for (const d of (al.detenidas || [])) {
      añadir({
        id: `alimentia-detenida-${al.periodo}-${String(d.company_id || d.nombre).slice(0, 36)}`,
        severidad: d.nunca_empezo ? 'critica' : 'atencion',
        titulo: d.nunca_empezo
          ? `${d.nombre} nunca ha diligenciado`
          : `${d.nombre} lleva ${nf(d.dias_sin_diligenciar)} días sin diligenciar`,
        detalle: d.nunca_empezo
          ? 'Tiene formatos habilitados y ningún registro: es un problema de puesta en marcha.'
          : 'Venía registrando y se detuvo: es señal temprana de abandono.',
        cifra: d.nunca_empezo ? 0 : Number(d.dias_sin_diligenciar),
        seccion: 'alimentia',
        accion: d.nunca_empezo ? 'Acompañar el arranque.' : 'Llamar antes de que se vaya.',
      });
    }

    if (Number.isFinite(Number(al.cumplimiento)) &&
        Number(al.cumplimiento) * 100 < U.cumplimientoBajo) {
      añadir({
        id: `alimentia-cumplimiento-${al.periodo}`,
        severidad: 'aviso',
        titulo: `Cumplimiento de Alimentia en ${pc(Number(al.cumplimiento) * 100)}`,
        detalle: al.advertencia_definicion || '',
        cifra: Number((Number(al.cumplimiento) * 100).toFixed(1)),
        seccion: 'alimentia',
        accion: 'Definir qué días son exigibles antes de leer esta cifra como mala.',
      });
    }
  }

  /* ---------------------------------------------------------------- cursos */
  if (c.cursos && Array.isArray(c.cursos.cursos)) {
    /* Por debajo de mil pesos es un precio mal escrito —Colgranja estaba en
       $20 en vez de $20.000— y por encima de cincuenta mil, en un catálogo
       donde todo vale 14.000 o 20.000, es un curso de prueba que no debería
       estar en producción. Las dos cosas descuadran el cruce. */
    const malos = c.cursos.cursos.filter((x) => {
      const n = Number(x.certificados ?? x.certificados_ultimos_12m ?? 0);
      const pr = Number(x.precio);
      return n > 0 && Number.isFinite(pr) && (pr < 1000 || pr > 50000);
    });
    if (malos.length) {
      añadir({
        id: `cursos-precio-${mes.id}`,
        severidad: 'atencion',
        para: 'gerencia',
        titulo: `${nf(malos.length)} curso${malos.length === 1 ? '' : 's'} con precio mal configurado`,
        detalle: malos.map((x) => `${x.nombre} a ${cop(x.precio)}`).join('; ') +
                 '. Descuadra el cruce contra lo facturado.',
        cifra: malos.length,
        seccion: 'cursos',
        accion: 'Corregir el precio en la plataforma de formación.',
      });
    }
  }

  const orden = { critica: 0, atencion: 1, aviso: 2 };
  return A.sort((a, b) => orden[a.severidad] - orden[b.severidad]);
}

/* ---------------------------------------------------------------- cartera
 * Las alertas de lo que está por cobrar van aparte porque la cartera llega
 * aparte: la produce su propio flujo, vive en su propio archivo y se adjunta
 * al servir, cuando generarAlertas ya corrió. Mezclarlas allá obligaría a
 * armar el corte dos veces.
 *
 * Las dos nombran pesos y nombran clientes, así que son de gerencia y nunca
 * salen hacia la vista de Equipo.
 * ----------------------------------------------------------------------- */
export function alertasDeCartera(cartera, umbrales = {}) {
  const U = { ...UMBRALES, ...umbrales };
  const A = [];
  if (!cartera || !Number.isFinite(Number(cartera.total)) || Number(cartera.total) <= 0) return A;

  const total = Number(cartera.total);
  /* El id se renueva cada mes: si el problema sigue en diciembre es otra
     tarjeta, y si se arregla dentro del mes no se crea una cada noche. */
  const periodo = String(cartera.corte || '').slice(0, 7) || 'sin-fecha';
  const nombreDe = (m) => (!m || !m.nombre || /^no aplica$/i.test(String(m.nombre).trim()))
    ? 'NIT ' + (m && m.nit) : m.nombre;

  /* ------------------------------------------------- lo que lleva vencido */
  const vencido = Number((cartera.por_antiguedad || {})['mas de 90']) || 0;
  const share = vencido / total * 100;
  if (vencido > 0 && share >= U.carteraVencida) {
    /* Quién más debe de los vencidos, para que la alerta diga por dónde
       empezar. El saldo es el total de ese cliente, no solo su parte
       vencida: el desglose por tramo es de toda la cartera, no por tercero. */
    const moroso = (cartera.mayores || [])
      .filter((m) => Number(m.mas_vieja_dias) > 90)
      .sort((a, b) => Number(b.saldo) - Number(a.saldo))[0];
    A.push({
      id: `cartera-vencida-${periodo}`,
      severidad: share >= U.carteraVencidaGrave ? 'critica' : 'atencion',
      para: 'gerencia',
      titulo: `${cop(vencido)} llevan más de 90 días sin cobrarse`,
      detalle: `Es el ${pc(share)} de los ${cop(total)} que hay por cobrar` +
        (moroso ? `. El mayor es ${nombreDe(moroso)}, con ${cop(moroso.saldo)} ` +
                  `y hasta ${nf(moroso.mas_vieja_dias)} días de atraso.` : '.'),
      cifra: Number(share.toFixed(1)),
      seccion: 'cobrar',
      accion: 'Decidir qué se gestiona y qué se da por perdido.',
    });
  }

  /* --------------------------------------------- todo en un solo cliente */
  const mayor = (cartera.mayores || [])[0];
  if (mayor && Number(mayor.saldo) > 0) {
    const conc = Number(mayor.saldo) / total * 100;
    if (conc >= U.carteraConcentracion) {
      A.push({
        id: `cartera-concentracion-${periodo}`,
        severidad: conc >= U.carteraConcentracionGrave ? 'critica' : 'atencion',
        para: 'gerencia',
        titulo: `${nombreDe(mayor)} debe el ${pc(conc)} de toda la cartera`,
        detalle: `${cop(mayor.saldo)} en ${nf(mayor.facturas)} factura` +
          (Number(mayor.facturas) === 1 ? '' : 's') +
          `. Que ese cliente se demore mueve la caja del mes entero.`,
        cifra: Number(conc.toFixed(1)),
        seccion: 'cobrar',
        accion: 'Confirmar la fecha de pago antes de contar con esa plata.',
      });
    }
  }

  return A;
}

/* ----------------------------------------------------------- el cruce
 * Dos alertas, y las dos de gerencia: una nombra plata sin facturar y la
 * otra señala registros que hay que corregir.
 *
 * El cruce es del último mes CERRADO. Eso importa para leer las cifras: no
 * dicen cómo va el mes, dicen qué pasó en uno que ya terminó y cuya
 * facturación ya tuvo tiempo de salir.
 * --------------------------------------------------------------------- */
export function alertasDeConciliacion(conc, umbrales = {}) {
  const U = { ...UMBRALES, ...umbrales };
  const A = [];
  if (!conc || !conc.resumen || !Array.isArray(conc.empresas)) return A;
  const periodo = conc.periodo || 'sin-periodo';

  /* Lo que falta por facturar DESPUES de aplicar el mes vencido. El calculo
     vive en conciliacion.mjs, no aqui: cuando cada quien lo contaba a su
     manera, la alerta y la pantalla decian cosas distintas. Esta funcion
     antes excluia a la empresa entera cuando se marcaba como mes vencido, y
     asi los 24 que a Arcos Dorados le siguen faltando desaparecian del total.
     Lo explicado por el desfase se descuenta; el resto sigue siendo plata
     sin facturar y tiene que salir. */
  const faltantes = conc.empresas
    .filter((e) => Number(e.sin_facturar) > 0)
    .sort((a, b) => Number(b.sin_facturar) - Number(a.sin_facturar));
  const total = faltantes.reduce((a, e) => a + Number(e.sin_facturar), 0);
  const valor = faltantes.reduce((a, e) => a + Number(e.valor_sin_facturar || 0), 0);

  if (total >= U.certSinFacturar) {
    const quien = (e) => e.nombre || e.codigo;
    A.push({
      id: `cruce-sin-facturar-${periodo}`,
      severidad: total >= U.certSinFacturarGrave ? 'critica' : 'atencion',
      para: 'gerencia',
      titulo: `${nf(total)} certificaciones de ${periodo} sin facturar` +
        (valor ? ` · ${cop(valor)}` : ''),
      /* Empresa por empresa, no solo el total: sin el detalle nadie sabe a
         quien llamar. */
      detalle: faltantes.slice(0, 6).map((e) =>
        `${quien(e)} ${nf(e.sin_facturar)}` +
        (e.valor_sin_facturar ? ` (${cop(e.valor_sin_facturar)})` : '') +
        (e.posible_desfase ? ', tras descontar el mes vencido' : '')).join('; ') +
        (faltantes.length > 6 ? `; y ${nf(faltantes.length - 6)} más.` : '.'),
      cifra: total,
      seccion: 'cruce',
      accion: 'Revisar con Siigo si falta facturar o si se facturó en otro mes.',
    });
  }

  /* Lo que el cruce no puede resolver. No es una diferencia de negocio: es
     un dato mal escrito, y se arregla en otro sitio y por otra persona. */
  const porCorregir = Number(conc.resumen.sin_nit || 0) + Number(conc.resumen.nit_no_resuelto || 0);
  if (porCorregir >= U.empresasSinNit) {
    A.push({
      id: `cruce-datos-${periodo}`,
      severidad: 'atencion',
      para: 'gerencia',
      titulo: `${nf(porCorregir)} empresas quedan fuera del cruce por su documento`,
      detalle: `${nf(conc.resumen.sin_nit || 0)} sin NIT en la plataforma y ` +
        `${nf(conc.resumen.nit_no_resuelto || 0)} con uno que no existe en Siigo. ` +
        'Mientras no se corrijan, lo que certifiquen no se puede cruzar.',
      cifra: porCorregir,
      seccion: 'cruce',
      accion: 'Corregir el documento de esas empresas en la plataforma de formación.',
    });
  }

  return A;
}

/* Adjunta la cartera al corte y suma sus alertas, ordenadas con las demás.
   Lo hacen los dos endpoints, así que vive aquí y no duplicado en cada uno. */

/* ------------------------------------------------------------ frescura
   El 20 de noviembre la lectura automática de Siigo no corrió, y lo único
   que lo decía era un «Al 19 de noviembre» en gris claro al lado de un
   título. Nadie lee eso. El tablero existe para que la Dirección no decida
   con cifras viejas creyéndolas de hoy, de modo que un dato viejo tiene que
   gritar igual que grita cualquier otro problema.

   Solo se mide la cartera y el cruce, que son lo único que sale de archivo:
   las certificaciones, las empresas y los vencimientos se leen de la
   plataforma en cada carga, y si esa lectura falla la página ya lo dice por
   su cuenta. Decir «el tablero está viejo» cuando solo lo está una parte
   haría que se desconfiara de todo, que es el error contrario. */
export function alertasDeFrescura(cartera, conciliacion, ahora = Date.now()) {
  const a = [];

  /* Un segundo fallo, distinto del anterior y que el anterior no ve: que la
     cartera corra y el corte no. Entonces el cruce es reciente pero esta
     hecho contra una lista de empresas vieja, y las dos fechas se ven igual
     de frescas porque las dos son la del extractor. Asi es como Waytic y la
     cuenta de super administrador siguieron saliendo en los datos por
     corregir durante dias despues de haberlas excluido. */
  const cu = conciliacion && conciliacion.corte_usado;
  if (cu && cu.generado_en && conciliacion.generado_en) {
    const atraso = (Date.parse(conciliacion.generado_en) - Date.parse(cu.generado_en)) / 36e5;
    if (Number.isFinite(atraso) && atraso >= UMBRALES.datoViejoHoras) {
      const d = Math.floor(atraso / 24);
      a.push({
        id: `corte-rezagado-${cu.corte || 'sin-fecha'}`,
        severidad: atraso >= UMBRALES.datoMuyViejoHoras ? 'critica' : 'atencion',
        para: 'gerencia',
        titulo: `El cruce se hizo contra una lista de empresas de hace ${d >= 1 ? `${nf(d)} día${d === 1 ? '' : 's'}` : `${nf(Math.floor(atraso))} horas`}`,
        detalle:
          `La lectura de Siigo sí corrió, pero la del corte no: el cruce de ${conciliacion.periodo || 'el mes'} ` +
          `está hecho contra las empresas del ${cu.corte}. Las que se hayan dado de alta, renombrado o ` +
          `excluido desde entonces salen mal en el cruce, en la lista de datos por corregir y en el saldo. ` +
          `Lo que viene de Siigo —lo que hay por cobrar— no está afectado.`,
        cifra: Math.round(atraso),
        seccion: 'cruce',
        accion: 'Volver a generar el corte; es ese proceso el que no está corriendo, no el de la cartera.',
      });
    }
  }

  const fuentes = [
    ['la cartera', cartera, 'cobrar'],
    ['el cruce contra lo facturado', conciliacion, 'cruce'],
  ].filter(([, x]) => x && x.generado_en);
  if (!fuentes.length) return a;

  /* Se avisa por la más vieja de las dos y una sola vez: son el mismo
     proceso y la misma causa, y dos alertas para un fallo son ruido. */
  const conEdad = fuentes.map(([que, x, seccion]) => {
    const t = Date.parse(x.generado_en);
    return { que, seccion, corte: x.corte, t, horas: Number.isFinite(t) ? (ahora - t) / 36e5 : null };
  }).filter((x) => x.horas !== null && x.horas >= 0);
  if (!conEdad.length) return a;

  const peor = conEdad.reduce((m, x) => (x.horas > m.horas ? x : m));
  if (peor.horas < UMBRALES.datoViejoHoras) return a;

  const dias = Math.floor(peor.horas / 24);
  const cuanto = dias >= 1
    ? `${nf(dias)} día${dias === 1 ? '' : 's'}`
    : `${nf(Math.floor(peor.horas))} horas`;
  const grave = peor.horas >= UMBRALES.datoMuyViejoHoras;

  a.push({
    id: `dato-viejo-${peor.corte || 'sin-fecha'}`,
    severidad: grave ? 'critica' : 'atencion',
    para: 'gerencia',
    titulo: `Las cifras de Siigo llevan ${cuanto} sin refrescarse`,
    detalle:
      `Lo último que se leyó de Siigo es del ${peor.corte}. Lo que hay por cobrar y el ` +
      `cruce contra lo facturado son de entonces, no de hoy. El resto del tablero ` +
      `—certificaciones, empresas, vencimientos— sí se lee en vivo y está al día.` +
      (grave ? ' Han fallado al menos dos lecturas seguidas.' : ''),
    cifra: Math.round(peor.horas),
    seccion: peor.seccion,
    accion: 'Revisar que la lectura automática de Siigo esté corriendo; mientras tanto, no dar estas cifras por actuales.',
  });
  return a;
}

export function adjuntarCartera(corte, cartera, conciliacion) {
  if (!corte) return corte;
  if (cartera) corte.cartera = cartera;
  if (conciliacion) corte.conciliacion = conciliacion;
  const nuevas = [...(cartera ? alertasDeCartera(cartera) : []),
                  ...(conciliacion ? alertasDeConciliacion(conciliacion) : [])];
  /* La de dato viejo va primera dentro de su severidad, y no por capricho:
     dice que las cifras con las que estan hechas las demas pueden no ser de
     hoy. Leer «Cencosud debe el 36 %» antes de saber que ese 36 % es de
     anteayer es el orden equivocado. El sort de JavaScript es estable, asi
     que basta ponerla delante. */
  const frescura = alertasDeFrescura(cartera, conciliacion);
  if (nuevas.length || frescura.length) {
    const orden = { critica: 0, atencion: 1, aviso: 2 };
    corte.alertas = [...frescura, ...(Array.isArray(corte.alertas) ? corte.alertas : []), ...nuevas]
      .sort((a, b) => orden[a.severidad] - orden[b.severidad]);
  }
  return corte;
}

/** Solo las que puede ver el equipo: ninguna que nombre pesos ni personas. */
export const alertasParaEquipo = (alertas) =>
  (alertas || []).filter((a) => a.para !== 'gerencia');

/** Resumen corto, para el asunto de un correo o el título de una tarjeta. */
export function resumirAlertas(alertas) {
  const n = (s) => (alertas || []).filter((a) => a.severidad === s).length;
  return { criticas: n('critica'), atencion: n('atencion'), avisos: n('aviso'), total: (alertas || []).length };
}
