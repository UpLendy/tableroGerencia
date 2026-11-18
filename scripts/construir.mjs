/* ---------------------------------------------------------------------------
 * construir.mjs — armar el corte a partir de lo ya traído. Sin tocar disco.
 *
 * Esto estaba dentro de extraer-corte.mjs, que es un comando de terminal. Al
 * moverlo a Vercel hacían falta los mismos pasos en otro sitio, y copiarlos
 * habría dejado dos versiones del congelado conviviendo. Ya nos pasó dos veces
 * que un detalle de orden en esa parte rompiera el corte en silencio, así que
 * la lógica vive aquí una sola vez y los dos extremos solo hacen entrada y
 * salida: el comando escribe archivos, la función escribe en GitHub.
 *
 * No lee ni escribe nada. Recibe lo traído y el registro, devuelve el corte y
 * el registro actualizado. Lo que haga quien llame con eso es asunto suyo.
 * ------------------------------------------------------------------------- */
import { armarCorte } from './mapeo.mjs';
import * as congelado from './congelado.mjs';
import { despojarParaEquipo, fugasDeEquipo } from './vista.mjs';

export const registroVacio = congelado.registroVacio;
export const ARCHIVO_REGISTRO = congelado.ARCHIVO;

/**
 * @param muestras   lo que devolvió traerTodasLasFuentes
 * @param tiempos    milisegundos por fuente
 * @param fallaron   { fuente: motivo } de las que no respondieron
 * @param narrativa  data/narrativa.json, o {} si no hay
 * @param registro   data/meses-cerrados.json, o registroVacio()
 * @param msTotal    cuánto tardó la consulta, para dejarlo anotado
 *
 * @returns { corte, registro, deriva, nuevos, fugas }
 *          fugas con algo dentro significa NO PUBLICAR.
 */
export function construir({ muestras, tiempos = {}, fallaron = {},
                            narrativa = {}, registro, msTotal = 0 }) {
  const reg = registro && registro.meses ? registro : congelado.registroVacio();

  /* Se arma dos veces a propósito: la primera para poder comparar contra lo
     cerrado, la segunda ya con la deriva dentro, porque las alertas se
     calculan en armarCorte y tienen que verla. Armar es cálculo sobre datos
     ya traídos; no cuesta una llamada más a nadie. */
  const preliminar = armarCorte(muestras, narrativa, fallaron);
  const deriva = congelado.deriva(reg, preliminar);

  const corte = armarCorte(muestras, narrativa, fallaron, {
    cerrados: reg,
    ...(deriva.length ? {
      deriva_meses_cerrados: { desde: preliminar.corte, cambios: deriva },
      /* Se conserva el nombre anterior para no romper a quien ya lo lee. */
      meses_cerrados_que_cambiaron: {
        desde: preliminar.corte,
        cambios: deriva.map((x) => ({
          periodo: x.periodo, campo: x.campo,
          antes: x.cerrado, despues: x.ahora, diferencia: x.diferencia,
        })),
      },
    } : {}),
  });

  corte.tiempos_ms = { ...tiempos, total: msTotal };

  /* Congelar va DESPUÉS de comparar: un mes que se cierra en este mismo corte
     no puede aparecer como deriva de sí mismo. */
  const { registro: actualizado, nuevos } = congelado.congelar(reg, corte);
  corte.meses_cerrados_registrados = Object.keys(actualizado.meses || {}).length;

  /* La vista de Equipo se comprueba antes de publicar, no después. Si se le
     escapa dinero, el corte no sale: ni a disco ni a GitHub. */
  const fugas = fugasDeEquipo(despojarParaEquipo(JSON.parse(JSON.stringify(corte))));

  return { corte, registro: actualizado, deriva, nuevos, fugas };
}

/** El resumen en texto, para que el comando y la función digan lo mismo. */
export function resumir({ corte, deriva, nuevos, fallaron = {} }) {
  const l = [];
  const n = Object.keys(fallaron).length;
  if (n) l.push(`${n} fuente(s) no respondieron: ` + Object.keys(fallaron).join(', '));
  for (const x of deriva) {
    l.push(`${x.periodo} · ${x.campo}: cerrado en ${x.cerrado} → hoy ${x.ahora} ` +
           `(${x.diferencia > 0 ? '+' : ''}${x.diferencia})`);
  }
  if (nuevos.length) l.push('se cierran: ' + nuevos.map((x) => `${x.periodo}=${x.cert}`).join(', '));
  l.push(`corte ${corte.corte} · ${(JSON.stringify(corte).length / 1024).toFixed(1)} KB`);
  return l;
}
