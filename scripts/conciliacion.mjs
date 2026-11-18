/* ---------------------------------------------------------------------------
 * conciliacion.mjs — lo que el tablero contó contra lo que Siigo facturó.
 *
 * Dos cosas distintas viven aquí, y conviene no confundirlas porque una
 * depende de la otra fuente y la otra no:
 *
 *   cartera()   sale ENTERA de Siigo. Cuánto se facturó, cuánto está sin
 *               cobrar y desde cuándo. No necesita el tablero para nada, así
 *               que puede correr aunque la plataforma de formación esté
 *               caída, que es exactamente lo que pasó esta semana.
 *
 *   conciliar() compara las certificaciones del tablero contra las unidades
 *               facturadas, empresa por empresa. Necesita las dos fuentes.
 *
 * Tres hechos medidos contra la cuenta real que explican el diseño:
 *
 *   · Los dos sistemas identifican al cliente distinto. La plataforma guarda
 *     el NIT en el registro de la empresa, a veces con dígito de
 *     verificación y a veces con guion; Siigo siempre sin él. No se calcula
 *     el dígito: se prueban las dos formas contra el maestro de terceros y
 *     gana la que exista. Si ninguna existe, se dice, y no se empareja.
 *
 *   · El canal particular se factura al NIT 222222222, consumidor final, con
 *     una línea de cantidad 1 y el valor completo de la venta. Ahí las
 *     unidades NO son certificaciones, así que ese canal se concilia por
 *     valor y nunca por cantidad. Decirlo desde el principio evita una
 *     diferencia inventada todos los meses.
 *
 *   · El producto "paquete" agrupa varias certificaciones en una unidad y
 *     todavía no se sabe cuántas. Mientras no se sepa, una empresa que
 *     compró paquetes NO se declara cuadrada ni descuadrada: se declara no
 *     comparable. Suponer un tamaño haría cuadrar un mes mintiendo.
 * ------------------------------------------------------------------------- */

export const REGLA = 'conciliacion-v1';

/** Códigos de producto que corresponden a certificaciones de la plataforma.
 *  Deducidos de los datos y PENDIENTES de que BPM los confirme: 21002 son
 *  certificaciones sueltas y 21007 paquetes. Todo lo demás que factura BPM
 *  —asesorías presenciales, trámites INVIMA, apto médico, comisiones— no
 *  pasa por la plataforma y no entra en la comparación. */
export const CODIGOS = { individual: ['21002'], paquete: ['21007'] };

export const CONSUMIDOR_FINAL = '222222222';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');
const num = (x) => Number(x) || 0;

/**
 * El NIT tal como lo conoce Siigo, a partir del documento de la plataforma.
 * Devuelve null si ninguna de las dos formas existe en el maestro.
 */
export function resolverNit(dniPlataforma, terceros) {
  const d = digitos(dniPlataforma);
  if (!d) return null;
  if (terceros.has(d)) return d;
  const sinDv = d.slice(0, -1);
  if (d.length > 1 && terceros.has(sinDv)) return sinDv;
  return null;
}

/** Qué compró cada tercero en el periodo, por código de producto. */
export function comprasPorTercero(facturas) {
  const mapa = new Map();
  for (const f of facturas) {
    const nit = digitos(f?.customer?.identification);
    if (!nit) continue;
    const e = mapa.get(nit) || {
      facturas: 0, total: 0, saldo: 0, porCodigo: new Map(), documentos: [],
    };
    e.facturas++;
    e.total += num(f.total);
    e.saldo += num(f.balance);
    e.documentos.push({ nombre: f.name || String(f.number || ''), fecha: f.date,
                        total: num(f.total), saldo: num(f.balance) });
    for (const it of (f.items || [])) {
      const cod = String(it.code ?? '?');
      const c = e.porCodigo.get(cod) || { cant: 0, valor: 0, precios: new Set() };
      c.cant += num(it.quantity);
      c.valor += num(it.total ?? num(it.price) * num(it.quantity));
      c.precios.add(Math.round(num(it.price)));
      e.porCodigo.set(cod, c);
    }
    mapa.set(nit, e);
  }
  return mapa;
}

/**
 * Cartera por tercero. Sale solo de Siigo.
 * `hoy` entra como parámetro y no se toma del reloj: así el mismo corte
 * produce el mismo resultado si se vuelve a armar.
 */
export function cartera(facturas, terceros, hoy) {
  const ref = Date.parse(hoy);
  const porNit = new Map();

  for (const f of facturas) {
    const saldo = num(f.balance);
    if (saldo <= 0) continue;
    const nit = digitos(f?.customer?.identification);
    const e = porNit.get(nit) || { nit, nombre: terceros.get(nit) || null, saldo: 0, facturas: [] };
    const dias = Number.isFinite(ref) && f.date
      ? Math.round((ref - Date.parse(f.date)) / 86400000) : null;
    e.saldo += saldo;
    e.facturas.push({ documento: f.name || String(f.number || ''), fecha: f.date, saldo, dias });
    porNit.set(nit, e);
  }

  const filas = [...porNit.values()].sort((a, b) => b.saldo - a.saldo);
  for (const x of filas) x.facturas.sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0));

  /* Tramos de antigüedad: lo que lleva más de 90 días es otra conversación
     que lo que lleva 15, y un total sin repartir no dice cuál es cuál. */
  const tramos = { 'hasta 30': 0, '31 a 60': 0, '61 a 90': 0, 'mas de 90': 0, 'sin fecha': 0 };
  for (const x of filas) {
    for (const f of x.facturas) {
      const k = f.dias === null ? 'sin fecha'
        : f.dias <= 30 ? 'hasta 30' : f.dias <= 60 ? '31 a 60'
        : f.dias <= 90 ? '61 a 90' : 'mas de 90';
      tramos[k] += f.saldo;
    }
  }

  /* El reparto por tramos DE CADA TERCERO, no solo del total. Sin esto no se
     puede contestar quien esta por pasar de 60 dias, que es justo lo que hay
     que saber para cobrar antes de que se venza. Publicar solo los quince
     mayores dejaba fuera a noventa y cinco. */
  const tramoDe = (d) => d === null ? 'sin fecha'
    : d <= 30 ? 'hasta 30' : d <= 60 ? '31 a 60' : d <= 90 ? '61 a 90' : 'mas de 90';
  const detalle = filas.map((x) => {
    const t = { 'hasta 30': 0, '31 a 60': 0, '61 a 90': 0, 'mas de 90': 0, 'sin fecha': 0 };
    for (const f of x.facturas) t[tramoDe(f.dias)] += f.saldo;
    return {
      nit: x.nit, nombre: x.nombre, saldo: x.saldo,
      facturas: x.facturas.length,
      mas_vieja_dias: x.facturas[0]?.dias ?? null,
      por_antiguedad: t,
    };
  });

  return {
    regla: REGLA,
    corte: hoy,
    total: filas.reduce((a, x) => a + x.saldo, 0),
    terceros: filas.length,
    por_antiguedad: tramos,
    /* Todos, no los quince primeros. Son cien terceros: cabe de sobra y
       permite contestar preguntas que antes obligaban a volver a Siigo. */
    detalle,
    mayores: detalle.slice(0, 15).map(({ por_antiguedad, ...r }) => r),
  };
}

/**
 * Lo facturado mes a mes, de todo lo que BPM vende.
 *
 * OJO con leer esto como ingreso de la plataforma: incluye tramites INVIMA,
 * asesorias presenciales, apto medico y lo que sea que BPM facture. No es
 * comparable con el valor a precio de lista del tablero, que solo cuenta
 * certificaciones. Ponerlos uno al lado del otro sin decirlo haria pensar
 * que falta plata donde solo hay dos cosas distintas.
 *
 * "cobrado" es lo facturado menos lo que sigue pendiente HOY, no lo que
 * entro ese mes: una factura de septiembre pagada en octubre cuenta como
 * cobrada en septiembre. Es la unica lectura posible con lo que la API
 * entrega, y por eso va dicho en el propio dato.
 */
export function facturadoPorMes(facturas) {
  const meses = {};
  for (const f of facturas) {
    const mes = String(f.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    const e = meses[mes] || { facturado: 0, saldo: 0, facturas: 0, por_codigo: {} };
    e.facturado += num(f.total);
    e.saldo += num(f.balance);
    e.facturas++;
    for (const it of (f.items || [])) {
      const cod = String(it.code ?? '?');
      const c = e.por_codigo[cod] || { cantidad: 0, valor: 0 };
      c.cantidad += num(it.quantity);
      c.valor += num(it.total ?? num(it.price) * num(it.quantity));
      e.por_codigo[cod] = c;
    }
    meses[mes] = e;
  }
  for (const e of Object.values(meses)) e.cobrado = e.facturado - e.saldo;
  return meses;
}

/**
 * La conciliación por empresa.
 *
 * @param empresas  las del corte: { codigo, nombre, nit, certificados }
 * @param compras   lo que devuelve comprasPorTercero()
 * @param terceros  NIT → nombre, del maestro de Siigo
 */
/**
 * El cruce de un mes.
 *
 * `compras` son las facturas FECHADAS en el mes. `comprasSiguiente`, las del
 * mes siguiente, y es opcional pero importa: hay clientes a los que BPM
 * factura a mes vencido, asi que el servicio de octubre aparece en una
 * factura de noviembre. Cruzar solo por fecha de factura los declara
 * descuadrados cuando no lo estan.
 *
 * Aqui NO se adivina cual cliente va a mes vencido: se publican las dos
 * cifras y se marca el caso en el que la del mes siguiente explica la
 * diferencia. Quien decide si eso es un desfase o un descuadre de verdad es
 * BPM, que es quien sabe como le factura a cada quien.
 */
export function conciliar(empresas, compras, terceros, comprasSiguiente) {
  const filas = [];
  const sinNit = [], noResuelto = [], soloEnSiigo = [];
  const usados = new Set();

  for (const emp of (empresas || [])) {
    const cert = num(emp.certificados ?? emp.cert);
    const base = { codigo: emp.codigo, nombre: emp.nombre, certificados: cert };

    if (!digitos(emp.nit)) { sinNit.push(base); filas.push({ ...base, estado: 'sin_nit' }); continue; }

    const nit = resolverNit(emp.nit, terceros);
    if (!nit) {
      noResuelto.push({ ...base, dni: emp.nit });
      filas.push({ ...base, dni: emp.nit, estado: 'nit_no_resuelto' });
      continue;
    }
    usados.add(nit);

    const compra = compras.get(nit);
    const nombreSiigo = terceros.get(nit) || null;
    if (!compra) {
      filas.push({ ...base, nit, nombre_siigo: nombreSiigo, unidades: 0,
                   estado: 'sin_factura_en_el_periodo' });
      continue;
    }

    let sueltas = 0, paquetes = 0, valor = 0;
    const precios = new Set();
    for (const [cod, c] of compra.porCodigo) {
      if (CODIGOS.individual.includes(cod)) { sueltas += c.cant; valor += c.valor; c.precios.forEach((x) => precios.add(x)); }
      else if (CODIGOS.paquete.includes(cod)) { paquetes += c.cant; valor += c.valor; }
    }

    /* Con paquetes de por medio no se puede afirmar que cuadre: no se sabe
       cuántas certificaciones trae uno. Se declara no comparable y se dice
       por qué, en vez de inventar un tamaño que haga cuadrar la cuenta. */
    const estado = paquetes > 0 ? 'no_comparable_por_paquetes'
      : sueltas === cert ? 'cuadra'
      : sueltas === 0 ? 'certifica_sin_facturar'
      : 'difiere';

    /* Lo mismo, pero con las facturas del mes siguiente. Si esa cifra se
       parece mucho mas a lo certificado que la del propio mes, lo que hay
       delante es un cliente facturado a mes vencido. */
    let sigSueltas = null;
    if (comprasSiguiente) {
      const cs = comprasSiguiente.get(nit);
      sigSueltas = 0;
      if (cs) for (const [cod, c] of cs.porCodigo) {
        if (CODIGOS.individual.includes(cod)) sigSueltas += c.cant;
      }
    }
    /* Que el mes siguiente se PAREZCA a lo certificado, no solo que quede
       mas cerca. Comparar distancias a secas marcaba como "a mes vencido" a
       quien no facturo nada el mes siguiente, porque cero queda cerca de
       cualquier numero pequeno: a Royal Films, con 91 certificadas y 186
       facturadas en octubre, le habria presentado un -91 inventado en vez
       del +95 real. Se exige que haya facturacion y que la diferencia sea
       menor al 15 %, que es lo que distingue un desfase de un descuadre. */
    const desfase = paquetes === 0 && sigSueltas !== null && sigSueltas > 0 && cert > 0 &&
      Math.abs(cert - sigSueltas) / cert <= 0.15 &&
      Math.abs(cert - sigSueltas) < Math.abs(cert - sueltas);

    filas.push({
      ...base, nit, nombre_siigo: nombreSiigo,
      unidades: sueltas, paquetes,
      ...(sigSueltas !== null ? { unidades_mes_siguiente: sigSueltas } : {}),
      ...(desfase ? {
        posible_desfase: true,
        diferencia_si_mes_vencido: sigSueltas - cert,
      } : {}),
      diferencia: paquetes > 0 ? null : sueltas - cert,
      valor_facturado: valor,
      tarifa: [...precios].sort((a, b) => a - b),
      saldo: compra.saldo,
      estado,
    });
  }

  /* Terceros que compraron curso y no son ninguna empresa del tablero. */
  for (const [nit, compra] of compras) {
    if (usados.has(nit) || nit === CONSUMIDOR_FINAL) continue;
    let u = 0, v = 0;
    for (const [cod, c] of compra.porCodigo) {
      if (CODIGOS.individual.includes(cod) || CODIGOS.paquete.includes(cod)) { u += c.cant; v += c.valor; }
    }
    if (u > 0) soloEnSiigo.push({ nit, nombre: terceros.get(nit) || null, unidades: u, valor: v });
  }

  /* El canal particular, por valor. Las unidades de consumidor final no son
     certificaciones: es una línea por venta con el monto completo. */
  const cf = compras.get(CONSUMIDOR_FINAL);
  let particular = null;
  if (cf) {
    let v = 0;
    for (const [cod, c] of cf.porCodigo) {
      if (CODIGOS.individual.includes(cod) || CODIGOS.paquete.includes(cod)) v += c.valor;
    }
    particular = {
      facturas: cf.facturas, valor_facturado: v, valor_total: cf.total,
      nota: 'Consumidor final factura una línea por venta con el valor completo, ' +
            'así que este canal se concilia por valor y no por cantidad.',
    };
  }

  const cuenta = (e) => filas.filter((f) => f.estado === e).length;
  const conDesfase = filas.filter((f) => f.posible_desfase).length;
  return {
    regla: REGLA,
    empresas: filas.sort((a, b) => b.certificados - a.certificados),
    particular,
    solo_en_siigo: soloEnSiigo.sort((a, b) => b.valor - a.valor),
    resumen: {
      total: filas.length,
      cuadran: cuenta('cuadra'),
      difieren: cuenta('difiere'),
      no_comparables: cuenta('no_comparable_por_paquetes'),
      certifican_sin_facturar: cuenta('certifica_sin_facturar'),
      sin_factura_en_el_periodo: cuenta('sin_factura_en_el_periodo'),
      sin_nit: sinNit.length,
      nit_no_resuelto: noResuelto.length,
      solo_en_siigo: soloEnSiigo.length,
      /* Cuantas de las que difieren se explicarian por facturacion a mes
         vencido. No se descuentan del conteo: se señalan. */
      posible_desfase: conDesfase,
    },
    /* Lo que BPM tiene que corregir en sus sistemas, separado de lo que es
       una diferencia de negocio. Son cosas distintas y se arreglan en sitios
       distintos. */
    datos_por_corregir: { sin_nit: sinNit, nit_no_resuelto: noResuelto },
  };
}
