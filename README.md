# Tablero gerencial · BPM Consulting SAS BIC

Tablero de lectura para la Dirección. Muestra el estado del negocio a partir de los
datos de la plataforma de formación, con una regla escrita al lado de cada cifra.

Referencia de la propuesta: **COT-2026-TABLERO-01** · regla de cálculo `virtual-metrics-v1`.

---

## Qué hay aquí

```
index.html                 el tablero entero: estructura, estilos y render
data/corte.json            las cifras del corte vigente — lo único que cambia mes a mes
scripts/validar-corte.mjs  guarda de consistencia del corte
vercel.json                configuración del despliegue
package.json               npm start (servidor local) · npm run validar
```

No hay build, ni framework, ni dependencias en producción. El navegador pide
`data/corte.json` y dibuja. Esa es toda la arquitectura, y es deliberada: el día
que los endpoints estén en aire, se cambia una constante y nada más.

---

## Verlo en local

```bash
npm start
```

Abre <http://localhost:4321>. Hace falta el servidor: abrir `index.html` con doble
clic no funciona, porque el navegador bloquea la lectura del JSON desde `file://`.
Si eso pasa, el tablero lo dice en pantalla en vez de quedarse en blanco.

---

## Actualizar el corte

1. Correr la extracción de solo lectura contra la plataforma (`corte_completo.js`
   con `mongosh`).
2. Volcar los resultados en `data/corte.json`.
3. `npm run validar` — comprueba que las cifras no se contradigan entre ellas:
   que los canales sumen el total, que las empresas sumen el canal empresa, que
   las activas coincidan con las que tienen movimiento, que los componentes del
   índice promedien el total. **No comprueba que las cifras sean verdad**, solo
   que sean coherentes. Si algo falla, sale con código 1 y dice qué.
4. `git commit` y `git push`. Vercel despliega solo.

### La forma de `corte.json`

| Clave | Qué es |
|---|---|
| `corte` | fecha de extracción, `YYYY-MM-DD` · alimenta el encabezado |
| `regla` | identificador de la regla de cálculo usada |
| `precioLista` | precio de referencia para valorar vencimientos y recompra |
| `meses[]` | un objeto por periodo: `cert`, `personas`, `ingreso`, `canal`, `activas`, `registradas`. El selector de periodo se construye solo a partir de esta lista |
| `salud` | `total` más un componente por barra, cada uno con su fórmula en `d` |
| `yoy` | acumulado del año y último mes, contra el año anterior |
| `venc` | vencimientos a 30 días, con la apertura de Arcos |
| `calidad` | una fila por verificación, con su tasa y su descuento |
| `prioridades` | las tarjetas de decisión: título, monto, sustento y responsable |
| `empresas[]` | `{codigo, nombre, meses:{"2026-10": n}}` · agregar un periodo es agregar una clave |

---

## Conectar los endpoints

Cuando la capa de métricas esté desplegada en `virtual.bpmsas.co`, en `index.html`:

```js
const FUENTE = 'data/corte.json';          // hoy
const FUENTE = '/api/v1/metrics/corte';    // mañana
```

El resto del tablero no se entera: ya consume la misma forma de datos. Lo que sí
hace falta antes es resolver el token de lectura (`metrics:read`) sin exponerlo en
el navegador, lo que probablemente signifique una función intermedia en Vercel que
guarde el token como variable de entorno y haga la petición del lado del servidor.

---

## Reglas que el tablero respeta

1. **No recalcula lo que BPM ya calcula.** Cada cifra se obtiene con la regla de la
   fuente que la produce. El tablero consolida y presenta; no reinterpreta.
2. **Un dato ausente no se muestra como cero.** Se muestra como ausente, diciendo
   qué endpoint lo trae y en qué entrega.
3. **Cada componente del índice lleva su fórmula escrita al lado.** Nadie debería
   tener que abrir el código para saber de dónde sale un número.

---

## Lo que todavía no tiene dato

| Bloque | Lo trae | Entrega |
|---|---|---|
| Serie mes a mes | endpoint `E1 · serie` | 1 |
| Apertura semanal de vencimientos | endpoint `E2 · vencimientos` | 1 |
| Catálogo completo de cursos | endpoint `E4 · cursos` | 1 |

---

*Juan Felipe López Sanabria · noviembre de 2026*
