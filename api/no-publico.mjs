/* ---------------------------------------------------------------------------
 * /api/no-publico — lo que antes estaba abierto.
 *
 * data/corte.json se servía como archivo estático, de modo que cualquiera con
 * la dirección tenía ingresos, precios por curso y la carga de cada ingeniero
 * con nombre propio, sin pasar por el tablero y sin dejar rastro.
 *
 * Ahora /data/ apunta aquí. El corte publicado se pide por /api/publicado, que
 * exige sesión y entrega lo que corresponde al rol.
 * ------------------------------------------------------------------------- */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({
    ok: false,
    error: 'no_publico',
    mensaje: 'El corte no se sirve como archivo. Se pide por /api/publicado, con sesión.',
  });
}
