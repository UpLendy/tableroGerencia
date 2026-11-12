/* Arma un corte con las muestras guardadas en muestras/, sin llamar a nadie.
   Sirve para probar el mapeo completo —incluido el congelamiento— sin tocar
   produccion y sin necesitar el token.

       node pruebas/corte-offline.mjs                    arma y revisa
       node pruebas/corte-offline.mjs --escribir         ademas guarda el corte

   No escribe nada salvo que se le pida. */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { armarCorte } from '../scripts/mapeo.mjs';
import { congelar, deriva, registroVacio, ARCHIVO } from '../scripts/congelado.mjs';

const dir = new URL('../muestras/', import.meta.url);
let archivos;
try {
  archivos = await readdir(dir);
} catch {
  /* muestras/ esta en .gitignore: son respuestas crudas de produccion y no
     van al repositorio. En CI no existe, y esto no es un fallo. */
  console.log('\n  sin muestras/ · nada que armar offline.');
  console.log('  Para generarlas: TABLERO_API_TOKEN=... npm run dump\n');
  process.exit(0);
}
const muestras = {};
for (const f of archivos) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  muestras[f.replace(/\.json$/, '')] = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
}
console.log('\n  muestras cargadas: ' + Object.keys(muestras).sort().join(', '));

let registro = registroVacio();
try {
  registro = JSON.parse(await readFile(new URL(ARCHIVO, import.meta.url), 'utf8'));
  console.log('  registro de meses cerrados: ' + Object.keys(registro.meses).length + ' mes(es)');
} catch { console.log('  sin registro de meses cerrados'); }

const preliminar = armarCorte(muestras, {}, {});
const laDeriva = deriva(registro, preliminar);
const corte = armarCorte(muestras, {}, {}, {
  cerrados: registro,
  ...(laDeriva.length ? { deriva_meses_cerrados: { desde: preliminar.corte, cambios: laDeriva } } : {}),
});

console.log('\n  corte ' + corte.corte + ' · regla ' + corte.regla);
console.log('');
for (const m of corte.meses) {
  const suma = (m.porCurso || []).reduce((a, c) => a + c.precio * c.certificados, 0);
  const certs = (m.porCurso || []).reduce((a, c) => a + c.certificados, 0);
  const marca = m.cerrado ? '  [cerrado el ' + m.cerrado_en + ']' : '  [en curso]';
  console.log('  ' + m.id + '  cert ' + String(m.cert).padStart(6) +
    '   valor ' + String('$' + m.ingreso.toLocaleString('es-CO')).padStart(14) + marca);
  console.log('        desglose: ' + (m.porCurso || []).length + ' curso(s), ' +
    certs + ' certificaciones, $' + suma.toLocaleString('es-CO') +
    (suma === m.ingreso && certs === m.cert ? '   ✓ cuadra' : '   ✗ NO CUADRA'));
  for (const c of (m.porCurso || []).slice(0, 12)) {
    console.log('          ' + String(c.nombre || '').slice(0, 46).padEnd(48) +
      String('$' + c.precio.toLocaleString('es-CO')).padStart(9) +
      String(c.certificados).padStart(7) +
      String('$' + (c.precio * c.certificados).toLocaleString('es-CO')).padStart(14));
  }
}

if (laDeriva.length) {
  console.log('\n  deriva de meses cerrados:');
  for (const x of laDeriva) {
    console.log('    ' + x.periodo + ' · ' + x.campo + ': cerrado en ' + x.cerrado +
      ' → hoy ' + x.ahora + ' (' + (x.diferencia > 0 ? '+' : '') + x.diferencia + ')');
  }
} else {
  console.log('\n  sin deriva contra lo cerrado');
}

const { registro: actualizado, nuevos } = congelar(registro, corte);
console.log('\n  se cerrarian ' + nuevos.length + ' mes(es): ' +
  (nuevos.map((x) => x.periodo + '=' + x.cert).join(', ') || '(ninguno)'));

const al = corte.alertas || [];
const porSev = al.reduce((a, x) => ({ ...a, [x.severidad]: (a[x.severidad] || 0) + 1 }), {});
console.log('\n  alertas: ' + JSON.stringify(porSev));
for (const a of al.filter((x) => x.severidad === 'critica')) {
  console.log('    critica · ' + a.titulo);
}

/* ------------------------------------------------------------------ cruce
   Lo que ninguna de las otras pruebas podia ver. La unitaria le pasa a
   aplicarCerrados un objeto completo, y esta prueba usaba las mismas muestras
   con las que se congelo, asi que las cifras coincidian por casualidad y una
   llamada incompleta pasaba inadvertida. Aqui el registro se perturba a
   proposito: si las cifras congeladas no llegan al corte, se nota. */
{
  let fallos = 0;
  const af = (bien, q) => { console.log((bien ? '  ok   ' : '  FALLA ') + q); if (!bien) fallos++; };
  console.log('\n  -- las cifras congeladas llegan al corte --');

  for (const m of corte.meses.filter((x) => x.cerrado)) {
    const suma = (corte.empresas || [])
      .reduce((a, e) => a + Number((e.meses || {})[m.id] || 0), 0);
    af(suma === m.canal.emp,
       m.id + ': la cartera suma ' + suma + ' y el canal dice ' + m.canal.emp);
  }

  const cerrado = Object.keys(registro.meses || {})[0];
  if (cerrado) {
    const falso = JSON.parse(JSON.stringify(registro));
    const r = falso.meses[cerrado];
    r.cert -= 1;
    r.canal.emp -= 1;
    r.por_empresa[0].certificados -= 1;
    const perturbado = armarCorte(muestras, {}, {}, { cerrados: falso });
    const mp = perturbado.meses.find((x) => x.id === cerrado);
    if (!mp) {
      af(false, cerrado + ' deberia estar entre los meses del corte');
    } else {
      const suma = perturbado.empresas
        .reduce((a, e) => a + Number((e.meses || {})[cerrado] || 0), 0);
      af(mp.cert === r.cert, 'el total del mes sale del registro, no de la plataforma');
      af(mp.canal.emp === r.canal.emp, 'el canal tambien');
      af(suma === r.canal.emp, 'y la cartera se reescribio para cuadrar con el');
    }
  } else {
    af(false, 'no hay ningun mes congelado con el que cruzar');
  }

  if (fallos) { console.log('\n  ' + fallos + ' fallo(s)\n'); process.exitCode = 1; }
}

if (process.argv.includes('--escribir')) {
  await writeFile(new URL('../data/corte.json', import.meta.url), JSON.stringify(corte, null, 2));
  /* Queda dicho que estos meses no los cerro el proceso nocturno sino esta
     prueba, a partir de un volcado guardado. La cifra es la que la plataforma
     reportaba ese dia y por eso vale —octubre cerro en 1.848 y hoy ya no se
     puede recuperar— pero presentarla como si la hubiera producido el corte
     automatico seria exactamente el tipo de cosa que hay que no hacer. */
  actualizado.sembrado = {
    por: 'pruebas/corte-offline.mjs',
    desde: 'muestras/ · volcado del ' + corte.corte,
    nota: 'Meses cerrados a partir de un volcado guardado, no de un corte ' +
          'programado. Las cifras son las que la plataforma reportaba ese dia.',
  };
  await writeFile(new URL(ARCHIVO, import.meta.url), JSON.stringify(actualizado, null, 2));
  console.log('\n  escritos data/corte.json y ' + ARCHIVO + ' (marcado como sembrado)');
}
console.log('');
