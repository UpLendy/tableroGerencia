/* Pruebas del envío de alertas a Trello.

   Es la primera cosa de este proyecto que escribe en algo de alguien, así
   que lo que se prueba aquí no es que funcione sino que no haga de más:
   que no pueda archivar ni borrar ni mover, que no mande a un tablero
   compartido las alertas que nombran dinero y clientes, y que correrlo dos
   veces no deje dos tarjetas. Todo sin red: el plan se calcula aparte de
   ejecutarlo justamente para poder mirarlo así. */
import { permiso, elegibles, planear, cuerpoDeTarjeta, idDeTarjeta, MARCA } from '../scripts/trello.mjs';

let fallos = 0;
const cierto = (v, q) => { console.log((v ? '  ok   ' : '  FALLA ') + q); if (!v) fallos++; };
const iguales = (a, b, q) => {
  const bien = JSON.stringify(a) === JSON.stringify(b);
  console.log((bien ? '  ok   ' : '  FALLA ') + q);
  if (!bien) { console.log('    esperado: ' + JSON.stringify(b)); console.log('    obtenido: ' + JSON.stringify(a)); fallos++; }
};

console.log('\n-- lo que este cliente NO puede hacer --');
cierto(!permiso('DELETE', '/cards/abc').ok, 'no puede borrar una tarjeta');
cierto(!permiso('DELETE', '/lists/abc').ok, 'ni una lista');
cierto(!permiso('DELETE', '/boards/abc').ok, 'ni un tablero');
cierto(!permiso('PUT', '/cards/abc', { closed: true }).ok, 'no puede archivar: closed no está permitido');
cierto(!permiso('PUT', '/cards/abc', { idList: 'otra' }).ok, 'ni mover de lista: idList tampoco');
cierto(!permiso('PUT', '/boards/abc', { name: 'x' }).ok, 'no puede renombrar el tablero');
cierto(!permiso('PUT', '/lists/abc', { name: 'x' }).ok, 'ni una lista');
cierto(!permiso('POST', '/boards', { name: 'x' }).ok, 'ni crear tableros');
cierto(!permiso('GET', '/members/me/boards').ok, 'ni curiosear los tableros de la cuenta');
cierto(!permiso('GET', '/boards/abc/cards').ok, 'ni leer todas las tarjetas de un tablero entero');
cierto(!permiso('GET', '/members/me/cards').ok, 'ni las tarjetas de la persona');

console.log('\n-- y lo que sí --');
cierto(permiso('GET', '/lists/abc/cards').ok, 'leer las tarjetas de su lista');
cierto(permiso('POST', '/cards').ok, 'crear una tarjeta');
cierto(permiso('PUT', '/cards/abc', { name: 'x', desc: 'y' }).ok, 'cambiarle el título y el texto');
cierto(permiso('POST', '/cards/abc/actions/comments').ok, 'y comentar');
cierto(permiso('GET', '/boards/abc/lists').ok,
  'y leer las listas de un tablero que se nombra, que hace falta para la puesta en marcha');

console.log('\n-- qué alertas salen de la empresa --');
{
  const as = [
    { id: 'a', severidad: 'critica', para: 'todos', titulo: 'A' },
    { id: 'b', severidad: 'critica', para: 'gerencia', titulo: 'B · $28.683.420 sin cobrar' },
    { id: 'c', severidad: 'atencion', para: 'todos', titulo: 'C' },
  ];
  const porDefecto = elegibles(as, { severidades: ['critica'], incluirGerencia: false });
  iguales(porDefecto.map((x) => x.id), ['a'],
    'por omisión solo las críticas, y las de gerencia NO salen del servidor');
  const conGerencia = elegibles(as, { severidades: ['critica'], incluirGerencia: true });
  iguales(conGerencia.map((x) => x.id), ['a', 'b'], 'salen solo si alguien lo activa a propósito');
  const dos = elegibles(as, { severidades: ['critica', 'atencion'], incluirGerencia: false });
  iguales(dos.map((x) => x.id), ['a', 'c'], 'y el filtro de severidad se puede ampliar');
}

console.log('\n-- correrlo dos veces no deja dos tarjetas --');
{
  const o = { severidades: ['critica'], incluirGerencia: false, corte: '2026-11-24' };
  const alerta = { id: 'cartera-vencida-2026-11', severidad: 'critica', para: 'todos',
                   titulo: '$28.683.420 llevan más de 90 días', detalle: 'Es el 24,4 %.', accion: 'Decidir.' };

  const primera = planear([alerta], [], o);
  iguales(primera.map((p) => p.accion), ['crear'], 'la primera noche la crea');

  /* Lo que Trello devolvería al día siguiente con esa tarjeta ya puesta. */
  const comoQuedo = [{ id: 'T1', name: alerta.titulo, desc: primera[0].desc }];
  const segunda = planear([alerta], comoQuedo, o);
  iguales(segunda.map((p) => p.accion), ['sin-cambios'],
    'la segunda noche, con la alerta igual, no escribe nada');

  const cambiada = { ...alerta, detalle: 'Es el 31,0 %.' };
  const tercera = planear([cambiada], comoQuedo, o);
  iguales(tercera.map((p) => p.accion), ['actualizar'], 'si la cifra cambia, actualiza la misma tarjeta');
  iguales(tercera[0].tarjeta, 'T1', 'la misma, no una nueva');
}

console.log('\n-- cuando la alerta desaparece --');
{
  const o = { severidades: ['critica'], incluirGerencia: false, corte: '2026-11-25' };
  const vieja = { id: 'cartera-vencida-2026-11', severidad: 'critica', para: 'todos', titulo: 'X', detalle: 'Y' };
  const tarjeta = { id: 'T1', name: 'X', desc: cuerpoDeTarjeta(vieja, '2026-11-24') };

  const p1 = planear([], [tarjeta], o);
  iguales(p1.map((x) => x.accion), ['avisar-resuelta'], 'avisa en la tarjeta que ya no aparece');
  cierto(/no la archiva/.test(p1[0].comentario), 'y dice explícitamente que no la archiva, para que nadie lo suponga');
  cierto(/ciérrala tú/.test(p1[0].comentario), 'deja el cierre a quien la esté trabajando');

  const p2 = planear([], [{ ...tarjeta, desc: p1[0].desc }], o);
  iguales(p2.map((x) => x.accion), ['ya-avisada'], 'y no lo repite todas las noches');
}

console.log('\n-- no toca lo que no es suyo --');
{
  const ajena = { id: 'T9', name: 'Tarjeta que escribió una persona', desc: 'cualquier cosa' };
  iguales(idDeTarjeta(ajena), null, 'una tarjeta sin la marca no es del tablero');
  const o = { severidades: ['critica'], incluirGerencia: false, corte: '2026-11-24' };
  iguales(planear([], [ajena], o), [], 'y no aparece en el plan ni para comentarla');
}

console.log('\n-- la tarjeta dice de dónde salió --');
{
  const d = cuerpoDeTarjeta({ id: 'x-1', severidad: 'critica', titulo: 'T', detalle: 'D', accion: 'A' }, '2026-11-24');
  cierto(d.includes(MARCA + ': x-1'), 'lleva la marca con el id, que es como se reconoce mañana');
  cierto(/Generada por el tablero/.test(d), 'y dice que no la escribió una persona');
  cierto(/corte del 2026-11-24/.test(d), 'con la fecha del corte');
}

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo en orden\n');
process.exit(fallos ? 1 : 0);
