/* ---------------------------------------------------------------------------
 * datos.mjs — leer los archivos que dejan los procesos nocturnos.
 *
 * Vercel no garantiza desde dónde corre una función, así que se prueban los
 * dos sitios donde puede estar data/. Estaba duplicado en /api/publicado y
 * hacía falta en dos sitios más, así que vive aquí.
 * ------------------------------------------------------------------------- */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function leerDato(nombre) {
  const rutas = [
    new URL(`../data/${nombre}`, import.meta.url),
    join(process.cwd(), 'data', nombre),
  ];
  let ultimo;
  for (const r of rutas) {
    try { return JSON.parse(await readFile(r, 'utf8')); }
    catch (e) { ultimo = e; }
  }
  throw ultimo;
}

/**
 * La cartera, si está publicada. Devuelve null si no, y no lanza: la cartera
 * la produce un proceso distinto del corte, y que ese proceso no haya corrido
 * todavía no es motivo para dejar al tablero sin pintar.
 */
export async function leerCartera() {
  try { return await leerDato('cartera.json'); }
  catch { return null; }
}

/**
 * El cruce contra Siigo, si está publicado. Mismo criterio que la cartera:
 * lo produce otro proceso y que no haya corrido todavía no es motivo para
 * dejar al tablero sin pintar.
 */
export async function leerConciliacion() {
  try { return await leerDato('conciliacion.json'); }
  catch { return null; }
}

/**
 * Lo que se leyó de Trello, si está publicado. Mismo criterio que la cartera.
 */
export async function leerTrello() {
  try { return await leerDato('trello.json'); }
  catch { return null; }
}
