/* ---------------------------------------------------------------------------
 * github.mjs — escribir archivos en el repositorio desde donde no hay git.
 *
 * El flujo de GitHub Actions hace `git push`. La función de Vercel no tiene
 * git ni disco donde clonar, así que usa la API de contenidos: leer el sha
 * del archivo, mandar el contenido nuevo, y GitHub crea el commit.
 *
 * Se escriben dos archivos (el corte y el registro de meses cerrados) y
 * tienen que entrar juntos: si entrara solo el corte, el congelado perdería
 * su memoria y volvería a congelar las cifras del día, que es exactamente lo
 * que no debe pasar. Por eso no se usan dos PUT sueltos sino un árbol y un
 * commit: o entran los dos, o no entra ninguno.
 *
 * Solo escribe lo que se le pasa. No borra, no crea ramas, no toca nada más.
 * ------------------------------------------------------------------------- */

const API = 'https://api.github.com';

function cliente(repo, token) {
  const pedir = async (ruta, opciones = {}) => {
    const r = await fetch(API + ruta, {
      ...opciones,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tablero-bpm',
        ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opciones.headers || {}),
      },
      signal: AbortSignal.timeout(30000),
    });
    const texto = await r.text();
    if (!r.ok) throw new Error(`GitHub ${ruta}: HTTP ${r.status} · ${texto.slice(0, 300)}`);
    return texto ? JSON.parse(texto) : null;
  };
  return pedir;
}

/**
 * Publica varios archivos en un solo commit sobre una rama.
 *
 * @param repo     "duenio/repositorio"
 * @param token    PAT con permiso de escritura de contenido en ese repositorio
 * @param rama     normalmente "main"
 * @param archivos { "data/corte.json": "<contenido>", ... }
 * @param mensaje  el mensaje del commit
 *
 * @returns { commit, cambios } · cambios=false si no había nada que cambiar
 */
export async function publicarArchivos({ repo, token, rama = 'main', archivos, mensaje }) {
  const pedir = cliente(repo, token);

  /* Dónde está la rama ahora. Todo lo que sigue cuelga de este commit, así
     que si alguien empuja mientras tanto, el update final falla y no se
     pisa su trabajo: GitHub rechaza mover la rama desde un padre viejo. */
  const ref = await pedir(`/repos/${repo}/git/refs/heads/${rama}`);
  const shaBase = ref.object.sha;
  const commitBase = await pedir(`/repos/${repo}/git/commits/${shaBase}`);

  /* Si el contenido es idéntico al que ya está publicado, no se commitea.
     Un commit diario que no cambia nada ensucia el historial y dispara un
     despliegue por gusto. */
  let iguales = true;
  for (const [ruta, contenido] of Object.entries(archivos)) {
    let actual = null;
    try {
      const f = await pedir(`/repos/${repo}/contents/${encodeURI(ruta)}?ref=${rama}`);
      actual = Buffer.from(f.content, 'base64').toString('utf8');
    } catch { actual = null; }
    if (actual !== contenido) { iguales = false; break; }
  }
  if (iguales) return { commit: null, cambios: false };

  /* Un blob por archivo, un árbol que los cuelga del árbol actual, un commit
     que apunta a ese árbol. Es la forma de que los dos archivos entren con
     el mismo commit. */
  const blobs = {};
  for (const [ruta, contenido] of Object.entries(archivos)) {
    const b = await pedir(`/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: Buffer.from(contenido, 'utf8').toString('base64'),
                             encoding: 'base64' }),
    });
    blobs[ruta] = b.sha;
  }

  const arbol = await pedir(`/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: commitBase.tree.sha,
      tree: Object.entries(blobs).map(([path, sha]) =>
        ({ path, mode: '100644', type: 'blob', sha })),
    }),
  });

  const commit = await pedir(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: mensaje, tree: arbol.sha, parents: [shaBase] }),
  });

  /* Sin force: si la rama se movió mientras tanto, esto falla y es lo
     correcto. Se reintenta en la corrida siguiente, que es dentro de un día;
     no hay nada que valga perder el empujón de otro por salvar. */
  await pedir(`/repos/${repo}/git/refs/heads/${rama}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { commit: commit.sha, cambios: true };
}
