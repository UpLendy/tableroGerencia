/* ---------------------------------------------------------------------------
 * congelado.mjs — el registro de los meses ya cerrados.
 *
 * Por qué existe. Las cifras mensuales de la plataforma NO son inmutables:
 * se mueven hacia atrás, por diseño y por dos rutas distintas.
 *
 *   1. Renovar un curso reutiliza el registro del certificado anterior y le
 *      sobre-escribe cert_date con la fecha del nuevo. El certificado no se
 *      duplica: se muda de mes. Sale del mes original y entra al mes en curso.
 *      Medido el 12 de noviembre de 2026: 209 certificados ya cambiaron de mes,
 *      85 de ellos salieron de octubre de 2025.
 *
 *   2. Asignar un código de empresa a un usuario sobre-escribe el cert_date de
 *      todos sus cursos activos con la fecha de la asignación. Esta ruta no
 *      deja rastro en el historial, así que no se puede contar.
 *
 * Consecuencia: octubre de 2025 marcaba 1.518 por la mañana y 1.512 por la
 * tarde del mismo día. No hay precisión posible contra un blanco móvil.
 *
 * La salida no es elegir un número sino dejar de perseguirlo: cuando un mes
 * cierra, su cifra se guarda aquí con la fecha en que se cerró y el precio con
 * el que se calculó, y no se vuelve a tocar nunca. De ahí en adelante el
 * tablero muestra la cifra cerrada y, si la plataforma empieza a reportar otra,
 * lo dice en voz alta en vez de recalcular en silencio.
 *
 * Eso convierte un problema irresoluble en un dato auditable: «octubre se
 * cerró en 1.845 el 1 de noviembre; hoy la plataforma reporta 1.843; estas
 * dos personas renovaron y su certificado cambió de fecha».
 *
 * El archivo es data/meses-cerrados.json y va al repositorio: es el único
 * lugar donde queda la cifra original, porque la plataforma ya no la tiene.
 * ------------------------------------------------------------------------- */

export const ARCHIVO = '../data/meses-cerrados.json';

/** Campos que se comparan para detectar deriva. El resto es contexto. */
export const CAMPOS = ['cert', 'personas', 'ingreso'];

export const registroVacio = () => ({ version: 1, meses: {} });

const mesDe = (fecha) => String(fecha || '').slice(0, 7);
const diaDe = (fecha) => Number(String(fecha || '').slice(8, 10)) || 0;

/** Distancia en meses entre dos periodos YYYY-MM. */
function mesesEntre(a, b) {
  const [aa, am] = a.split('-').map(Number);
  const [ba, bm] = b.split('-').map(Number);
  return (ba - aa) * 12 + (bm - am);
}

/**
 * ¿Se puede congelar este periodo con este corte?
 *
 * Tiene que estar cerrado —ser anterior al mes del corte— y, si el corte es
 * del mes siguiente, haber pasado del día 1. La capa de métricas cachea la
 * serie 24 horas: un corte del día 1 puede traer todavía el valor del mes
 * anterior calculado antes de medianoche, y congelar eso sería congelar un
 * número viejo para siempre.
 */
export function sePuedeCongelar(periodo, fechaCorte) {
  const mesCorte = mesDe(fechaCorte);
  if (!periodo || !mesCorte || periodo >= mesCorte) return false;
  return mesesEntre(periodo, mesCorte) > 1 || diaDe(fechaCorte) >= 2;
}

/** Lo que se guarda de un mes que viene del resumen (trae todo). */
function retratoDeMes(m) {
  const r = {
    periodo: m.id,
    cert: Number(m.cert),
    personas: Number(m.personas),
    ingreso: Number(m.ingreso),
    origen: 'resumen',
  };
  if (m.canal) r.canal = { emp: Number(m.canal.emp), par: Number(m.canal.par) };
  if (Number.isFinite(Number(m.activas))) r.empresas_activas = Number(m.activas);
  /* El precio queda congelado junto con la cifra. Es lo que impide que
     cambiar un co_price en la plataforma recalcule un mes ya informado, que
     es exactamente lo que la Dirección pidió en su observación B3. */
  if (Array.isArray(m.porCurso) && m.porCurso.length) {
    r.por_curso = m.porCurso.map((c) => ({
      course_id: c.course_id, nombre: c.nombre,
      precio: Number(c.precio), certificados: Number(c.certificados),
    }));
  }
  return r;
}

/** Lo que se guarda de un mes que solo aparece en la serie (trae menos). */
const retratoDeSerie = (p) => ({
  periodo: p.periodo,
  cert: Number(p.certificados),
  personas: Number(p.personas),
  origen: 'serie',
});

/**
 * Congela los meses cerrados que todavía no estén en el registro.
 * No modifica nunca uno existente: la primera cifra es la que vale.
 */
export function congelar(reg, corte) {
  const r = reg && reg.meses ? reg : registroVacio();
  const nuevos = [];
  const fecha = corte.corte;

  const candidatos = [];
  for (const m of corte.meses || []) {
    if (m && m.id) candidatos.push([m.id, () => retratoDeMes(m)]);
  }
  for (const p of corte.serie || []) {
    if (p && p.periodo) candidatos.push([p.periodo, () => retratoDeSerie(p)]);
  }

  for (const [periodo, hacer] of candidatos) {
    if (r.meses[periodo]) continue;                  // ya cerrado: intocable
    if (!sePuedeCongelar(periodo, fecha)) continue;
    const retrato = hacer();
    if (!Number.isFinite(retrato.cert)) continue;
    retrato.cerrado_en = fecha;
    retrato.regla = corte.regla || null;
    /* Honestidad sobre el origen de la cifra. Un mes congelado el mes
       siguiente a su cierre guarda el valor con el que cerró de verdad. Un mes
       que ya estaba cerrado cuando este registro empezó a existir guarda el
       valor que la plataforma reportaba ESE día, que no es el original: los
       certificados que se mudaron de mes antes de esa fecha ya se habían ido y
       no hay forma de recuperarlos. Marcarlo evita que después se presente
       como la cifra de cierre cuando no lo es. */
    retrato.al_cierre = mesesEntre(periodo, mesDe(fecha)) === 1;
    if (!retrato.al_cierre) {
      retrato.nota = 'Congelado después del cierre: es el valor que la plataforma ' +
        'reportaba el ' + fecha + ', no necesariamente el del cierre del mes.';
    }
    r.meses[periodo] = retrato;
    nuevos.push(retrato);
  }

  r.actualizado_en = new Date().toISOString();
  nuevos.sort((a, b) => a.periodo.localeCompare(b.periodo));
  return { registro: r, nuevos };
}

/**
 * Compara lo cerrado contra lo que la plataforma reporta hoy.
 * Devuelve una entrada por campo que se movió.
 */
export function deriva(reg, corte) {
  if (!reg || !reg.meses) return [];
  const salida = [];

  const porResumen = new Map((corte.meses || []).map((m) => [m.id, m]));
  const porSerie = new Map((corte.serie || []).map((p) => [p.periodo, p]));

  for (const [periodo, cerrado] of Object.entries(reg.meses)) {
    const m = porResumen.get(periodo);
    const s = porSerie.get(periodo);
    if (!m && !s) continue;

    const ahora = {
      cert: m ? Number(m.cert) : Number(s.certificados),
      personas: m ? Number(m.personas) : Number(s.personas),
      ingreso: m ? Number(m.ingreso) : undefined,
    };

    for (const campo of CAMPOS) {
      const a = Number(cerrado[campo]);
      const b = Number(ahora[campo]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
      salida.push({
        periodo, campo,
        cerrado: a, ahora: b, diferencia: b - a,
        cerrado_en: cerrado.cerrado_en || null,
      });
    }
  }

  salida.sort((x, y) => y.periodo.localeCompare(x.periodo) || x.campo.localeCompare(y.campo));
  return salida;
}

/**
 * Sustituye en el corte las cifras de los meses ya cerrados por las que se
 * congelaron. Es lo que hace que un mes informado deje de moverse.
 *
 * Se aplica ANTES de calcular lo derivado —año contra año, índice de salud,
 * concentración, precio observado— para que todo salga de la misma cifra. Si
 * se aplicara después, el tablero mostraría el total cerrado y los indicadores
 * calculados sobre otro número.
 *
 * Lo que NO se congela, y hay que decirlo: el desglose por empresa. Esas
 * cifras se siguen leyendo en vivo, porque congelar la cartera entera de cada
 * mes multiplicaría el tamaño del registro por veinte para una sección que se
 * mira por tendencia y no por total. La alerta de deriva cubre la diferencia.
 */
export function aplicarCerrados(corte, reg) {
  if (!reg || !reg.meses) return { aplicados: [] };
  const aplicados = [];

  for (const m of corte.meses || []) {
    const c = reg.meses[m.id];
    if (!c) continue;
    if (Number.isFinite(Number(c.cert))) m.cert = Number(c.cert);
    if (Number.isFinite(Number(c.personas))) m.personas = Number(c.personas);
    if (Number.isFinite(Number(c.ingreso))) m.ingreso = Number(c.ingreso);
    if (c.canal) m.canal = { emp: Number(c.canal.emp), par: Number(c.canal.par) };
    if (Number.isFinite(Number(c.empresas_activas))) m.activas = Number(c.empresas_activas);
    if (Array.isArray(c.por_curso) && c.por_curso.length) m.porCurso = c.por_curso.map((x) => ({ ...x }));
    m.cerrado = true;
    m.cerrado_en = c.cerrado_en || null;
    aplicados.push(m.id);
  }

  for (const p of corte.serie || []) {
    const c = reg.meses[p.periodo];
    if (!c) continue;
    if (Number.isFinite(Number(c.cert))) p.certificados = Number(c.cert);
    if (Number.isFinite(Number(c.personas))) p.personas = Number(c.personas);
    p.cerrado = true;
    if (!aplicados.includes(p.periodo)) aplicados.push(p.periodo);
  }

  aplicados.sort();
  return { aplicados };
}

/** Resumen de una línea, para el log del proceso. */
export function resumirDeriva(d) {
  const meses = new Set((d || []).map((x) => x.periodo));
  const cert = (d || []).filter((x) => x.campo === 'cert')
    .reduce((a, x) => a + x.diferencia, 0);
  return { entradas: (d || []).length, meses: meses.size, certificados: cert };
}
