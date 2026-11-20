/* Pruebas de alcance de public/index.html.

   Son 2.500 líneas de guion en un solo ámbito global, y esa forma ya ha
   fallado tres veces de la misma manera: `corto` definido dentro de una
   función y llamado desde otra; `verTabla` apuntando siempre a la misma
   tabla; y un enlace nuevo bautizado `irA`, nombre que ya era del selector
   de mes y que al declararse después ganaba, de modo que pulsar una alerta
   le pedía a la plataforma el periodo «cobrar».

   Ninguna de las tres se ve leyendo el archivo. Las tres se ven contando
   nombres, que es lo que hace esto. */
import { readFileSync } from 'node:fs';

let fallos = 0;
const cierto = (v, q) => {
  console.log((v ? '  ok   ' : '  FALLA ') + q);
  if (!v) fallos++;
};

const html = readFileSync('public/index.html', 'utf8');
const guion = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const lineas = guion.split('\n');

/* Declaraciones del ámbito global: las de este archivo van sin sangría. */
const declarado = new Map();
const RE = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/;
lineas.forEach((l, i) => {
  const m = RE.exec(l);
  if (!m) return;
  const n = m[1] || m[2];
  if (!declarado.has(n)) declarado.set(n, []);
  declarado.get(n).push(i + 1);
});
const funciones = new Set(
  lineas.flatMap((l) => {
    const m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(l);
    return m ? [m[1]] : [];
  }),
);

console.log(`\n-- ${declarado.size} nombres en el ámbito global --`);
const repetidos = [...declarado.entries()].filter(([, ls]) => ls.length > 1);
repetidos.forEach(([n, ls]) => console.log(`     ${n}: líneas ${ls.join(', ')}`));
cierto(repetidos.length === 0, 'ningún nombre global se declara dos veces');

/* Un onclick del HTML solo ve el ámbito global. Si nombra algo que no está
   declarado ahí, el botón no hace nada —o peor, hace otra cosa. */
console.log('\n-- lo que el HTML llama desde un onclick --');
const llamadas = new Set();
for (const m of html.matchAll(/onclick="([A-Za-z0-9_$]+)\s*\(/g)) llamadas.add(m[1]);
/* Y los que se escriben desde el propio guion, dentro de una plantilla. */
for (const m of guion.matchAll(/onclick=\\?["']?\$?\{?\s*([A-Za-z0-9_$]+)\s*\(/g)) llamadas.add(m[1]);
[...llamadas].sort().forEach((n) =>
  cierto(funciones.has(n), `onclick="${n}(…)" existe como función global`),
);

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo en orden\n');
process.exit(fallos ? 1 : 0);
