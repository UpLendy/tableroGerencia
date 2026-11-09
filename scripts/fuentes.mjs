/* ---------------------------------------------------------------------------
 * fuentes.mjs — las tres plataformas que alimentan el tablero.
 *
 * Cada una es independiente: si una no responde, el corte sale con las otras
 * dos y esa queda declarada como ausente. Con una sola fuente eso no
 * importaba; con tres, que caiga una no puede tumbar la pantalla entera.
 * ------------------------------------------------------------------------- */

export const FUENTES = {
  formacion: {
    nombre: 'Plataforma de formación',
    base: process.env.TABLERO_API_BASE || 'https://virtual.bpmsas.co/api/v1/metrics',
    token: () => process.env.TABLERO_API_TOKEN,
    regla: 'virtual-metrics-v1',
  },
  tramites: {
    nombre: 'Plataforma de trámites',
    base: process.env.TRAMITES_API_BASE || 'https://bpm.lat/api/v1/metrics',
    token: () => process.env.TRAMITES_API_TOKEN,
    regla: 'tramites-metrics-v1',
  },
  alimentia: {
    nombre: 'Alimentia',
    base: process.env.ALIMENTIA_API_BASE || 'https://3-19-160-203.sslip.io/api/metrics',
    token: () => process.env.ALIMENTIA_API_TOKEN,
    regla: 'alimentia-metrics-v2',
  },
};

/**
 * Empresas de demostración de Alimentia, excluidas por id.
 *
 * No se filtra por estado: los clientes reales de BPM también figuran como
 * "prueba", así que filtrar por ahí los borraría del tablero. La lista la
 * entregó quien desplegó esa plataforma y hay que mantenerla a mano: si
 * aparece una demo nueva, se agrega aquí.
 */
export const EMPRESAS_DEMO_ALIMENTIA = new Set([
  '701f6f35-a5a9-4d31-adba-50e0e489e8dd',
  '690d384a-8001-4821-a007-9df635227904',
  '87cd3b5e-0f76-4871-b561-c0e57409fbc2',
]);

/** Llamados de trámites para un periodo. */
export function llamadasTramites(periodo) {
  const [year, month] = periodo.split('-').map(Number);
  return [
    { nombre: 'tr_carga',     ruta: 'carga-ingenieros',  params: { year, month } },
    { nombre: 'tr_tiempos',   ruta: 'tiempos-etapa',     params: { year, month } },
    { nombre: 'tr_retrabajo', ruta: 'retrabajo',         params: { year, month } },
    { nombre: 'tr_duracion',  ruta: 'duracion-procesos', params: { year, month } },
  ];
}

/** Llamados de Alimentia para un periodo. */
export function llamadasAlimentia(periodo) {
  const [year, month] = periodo.split('-').map(Number);
  return [
    { nombre: 'al_diligenciamiento', ruta: 'diligenciamiento', params: { year, month } },
    { nombre: 'al_caida',            ruta: 'caida-de-uso',     params: { year, month } },
  ];
}
