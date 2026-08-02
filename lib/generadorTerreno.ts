import { claveCoord, coordsEnRadio, distanciaChebyshev, vecinos, type Coord } from './isoGrid';
import type { GridBioma, TileBioma } from './tipos';

const TIPOS_NO_TRANSITABLES = new Set(['montana', 'rio']);

export function esTransitable(tile: Pick<TileBioma, 'tipo'>): boolean {
  return !TIPOS_NO_TRANSITABLES.has(tile.tipo);
}

interface OpcionesGeneracion {
  n: number;
  intentosMaximos?: number;
}

export function generarTerreno({ n, intentosMaximos = 6 }: OpcionesGeneracion): GridBioma {
  const spawn: Coord = { x: n - 1, y: n - 1 };
  const portal: Coord = { x: 0, y: 0 };

  let ultimoIntento: TileBioma[] = [];
  for (let intento = 0; intento < intentosMaximos; intento++) {
    ultimoIntento = generarIntento(n, spawn, portal);
    if (hayConectividad(n, ultimoIntento, spawn, portal)) {
      return { n, spawn, portal, tiles: ultimoIntento };
    }
  }

  // Fallback (raro): tallar el camino que cruza la menor cantidad de
  // obstáculos posible, para garantizar conectividad siempre.
  const tiles = tallarCaminoMinimo(n, ultimoIntento, spawn, portal);
  return { n, spawn, portal, tiles };
}

function generarIntento(n: number, spawn: Coord, portal: Coord): TileBioma[] {
  const tiles: TileBioma[] = [];
  const indice = new Map<string, TileBioma>();
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const tile: TileBioma = { x, y, tipo: 'arena', recurso: null };
      tiles.push(tile);
      indice.set(claveCoord(tile), tile);
    }
  }

  const numClusters = Math.max(2, Math.round(n / 6));
  const tamanoClusterMin = Math.round(n * 0.5);
  const tamanoClusterMax = Math.round(n * 1.3);
  for (let c = 0; c < numClusters; c++) {
    generarClusterMontana(n, indice, tamanoClusterMin, tamanoClusterMax);
  }

  const numRios = Math.max(1, Math.round(n / 12));
  for (let r = 0; r < numRios; r++) {
    generarRio(n, indice);
  }
  // Una sola pasada no alcanza a sanar cadenas (A cerca de B en diagonal,
  // y la esquina recién agregada para unirlos queda a su vez en diagonal
  // de C) — repetir hasta que no cambie nada más, con un tope por las dudas.
  for (let pasada = 0; pasada < 4; pasada++) {
    if (!sanarUnionesDiagonales(indice)) break;
  }

  despejarRadio(indice, spawn, 2);
  despejarRadio(indice, portal, 2);

  const tilePortal = indice.get(claveCoord(portal));
  if (tilePortal) tilePortal.tipo = 'portal';

  // Elementos sueltos (no en clusters como las montañas), transitables como
  // la madera de prueba: árbol (tipo 'arbol', da recurso 'madera') y
  // piedra/lana (siguen en 'arena', solo cambia el recurso). Se esparcen
  // DESPUÉS de despejarRadio para no pisar la zona segura del spawn/portal,
  // y cada llamada solo considera tiles que sigan en 'arena' sin recurso
  // (así nunca compiten entre sí por la misma casilla).
  esparcirElementos(indice, spawn, portal, PROB_ARBOL, (tile) => {
    tile.tipo = 'arbol';
    tile.recurso = 'madera';
  });
  esparcirElementos(indice, spawn, portal, PROB_RECURSO, (tile) => {
    tile.recurso = 'piedra';
  });
  esparcirElementos(indice, spawn, portal, PROB_RECURSO, (tile) => {
    tile.recurso = 'lana';
  });

  // Cofres escondidos: lejos del spawn (más que árboles/piedra/lana, así
  // hace falta explorar para encontrarlos), con loot de material al azar.
  // El generador no tiene acceso a la DB, así que no puede resolver un
  // objetoId real acá — deja el *nombre* del objeto en `cofrePendiente` y
  // un SQL aparte lo resuelve a `cofre` (ver tipos.ts).
  esparcirCofres(indice, spawn, portal);

  return tiles;
}

const RADIO_SEGURO_SPAWN = 1;
const RADIO_ESCONDIDO_COFRE = 4;
const PROB_ARBOL = 0.035;
const PROB_RECURSO = 0.02;
const PROB_COFRE = 0.012;
const LOOT_COFRE_ESCONDIDO = ['Madera', 'Piedra', 'Lana'] as const;

function esparcirCofres(indice: Map<string, TileBioma>, spawn: Coord, portal: Coord) {
  for (const tile of indice.values()) {
    if (tile.tipo !== 'arena' || tile.recurso || tile.cofre) continue;
    if (distanciaChebyshev(tile, spawn) <= RADIO_ESCONDIDO_COFRE) continue;
    if (distanciaChebyshev(tile, portal) <= RADIO_SEGURO_SPAWN) continue;
    if (Math.random() < PROB_COFRE) {
      tile.cofrePendiente = elegir(LOOT_COFRE_ESCONDIDO);
    }
  }
}

function esparcirElementos(
  indice: Map<string, TileBioma>,
  spawn: Coord,
  portal: Coord,
  probabilidad: number,
  aplicar: (tile: TileBioma) => void
) {
  for (const tile of indice.values()) {
    if (tile.tipo !== 'arena' || tile.recurso) continue;
    if (distanciaChebyshev(tile, spawn) <= RADIO_SEGURO_SPAWN) continue;
    if (distanciaChebyshev(tile, portal) <= RADIO_SEGURO_SPAWN) continue;
    if (Math.random() < probabilidad) aplicar(tile);
  }
}

function generarClusterMontana(
  n: number,
  indice: Map<string, TileBioma>,
  tamanoMin: number,
  tamanoMax: number
) {
  const semilla: Coord = { x: aleatorioEntero(0, n - 1), y: aleatorioEntero(0, n - 1) };
  const tamanoObjetivo = aleatorioEntero(tamanoMin, tamanoMax);
  const colocadas = new Set<string>();
  const frontera: Coord[] = [semilla];

  while (colocadas.size < tamanoObjetivo && frontera.length > 0) {
    const idx = aleatorioEntero(0, frontera.length - 1);
    const actual = frontera.splice(idx, 1)[0];
    const clave = claveCoord(actual);
    if (colocadas.has(clave) || !dentroDelGrid(actual, n)) continue;
    colocadas.add(clave);
    const tile = indice.get(clave);
    if (tile) tile.tipo = 'montana';

    for (const vecino of vecinos(actual)) {
      if (dentroDelGrid(vecino, n) && !colocadas.has(claveCoord(vecino)) && Math.random() < 0.6) {
        frontera.push(vecino);
      }
    }
  }
}

const LADOS = ['arriba', 'abajo', 'izquierda', 'derecha'] as const;
const CARDINALES: Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

// Busca nacer el río pegado a una montaña (como en la vida real, un
// nacimiento/manantial) en vez de en arena plana al borde del mapa. Elige
// una montaña al azar y un vecino cardinal suyo que sea arena — el río
// arranca ahí, fluyendo hacia afuera de la montaña. Si no encuentra un
// candidato válido en varios intentos (mapas casi sin montaña, montañas
// totalmente rodeadas de otras montañas, etc.), devuelve null y el
// llamador cae al método viejo (nacer en un borde del mapa).
function buscarInicioJuntoAMontana(
  n: number,
  indice: Map<string, TileBioma>
): { pos: Coord; direccion: Coord } | null {
  const montanas = Array.from(indice.values()).filter((t) => t.tipo === 'montana');
  if (montanas.length === 0) return null;

  for (let intento = 0; intento < 20; intento++) {
    const montana = montanas[aleatorioEntero(0, montanas.length - 1)];
    const candidatos = CARDINALES.map((d) => ({
      pos: { x: montana.x + d.x, y: montana.y + d.y },
      // El río fluye alejándose de la montaña: dirección opuesta a la que
      // apunta desde el candidato hacia la montaña.
      direccion: { x: -d.x, y: -d.y },
    })).filter(
      (c) => dentroDelGrid(c.pos, n) && indice.get(claveCoord(c.pos))?.tipo === 'arena'
    );
    if (candidatos.length > 0) {
      return candidatos[aleatorioEntero(0, candidatos.length - 1)];
    }
  }
  return null;
}

function generarRio(n: number, indice: Map<string, TileBioma>) {
  const inicioMontana = Math.random() < 0.6 ? buscarInicioJuntoAMontana(n, indice) : null;

  let pos: Coord;
  let direccion: Coord;
  if (inicioMontana) {
    pos = inicioMontana.pos;
    direccion = inicioMontana.direccion;
  } else {
    const lado = elegir(LADOS);
    switch (lado) {
      case 'arriba':
        pos = { x: aleatorioEntero(0, n - 1), y: 0 };
        direccion = { x: 0, y: 1 };
        break;
      case 'abajo':
        pos = { x: aleatorioEntero(0, n - 1), y: n - 1 };
        direccion = { x: 0, y: -1 };
        break;
      case 'izquierda':
        pos = { x: 0, y: aleatorioEntero(0, n - 1) };
        direccion = { x: 1, y: 0 };
        break;
      default:
        pos = { x: n - 1, y: aleatorioEntero(0, n - 1) };
        direccion = { x: -1, y: 0 };
    }
  }

  const longitud = aleatorioEntero(Math.round(n * 0.5), Math.round(n * 1.0));
  const perpendicular: Coord = direccion.x !== 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };

  const MIN_TRAMO_RECTO = 3;
  const PROB_TRAMO_ANCHO = 0.2;
  let pasosDesdeUltimoDesvio = 0;
  // Antes esto era una sola decisión para TODO el río (dosCasillasDeAncho):
  // si salía true, cada tile del recorrido completo quedaba con un vecino
  // paralelo extra, o sea 3 vecinos cardinales en cada tile — un cruce en T
  // ("afluente") en cada casilla del tramo entero, no una variación
  // ocasional. Ahora se decide de nuevo en cada tramo recto (cuando
  // pasosDesdeUltimoDesvio se reinicia), así el ensanche dura solo ese
  // tramo (al menos MIN_TRAMO_RECTO tiles) y después vuelve a angosto.
  let tramoActualEsAncho = Math.random() < PROB_TRAMO_ANCHO;

  let actual = { ...pos };
  for (let i = 0; i < longitud; i++) {
    if (!dentroDelGrid(actual, n)) break;
    marcarSiExiste(indice, actual, 'rio');
    if (tramoActualEsAncho) {
      marcarSiExiste(
        indice,
        { x: actual.x + perpendicular.x, y: actual.y + perpendicular.y },
        'rio'
      );
    }

    // Paso siempre cardinal, nunca diagonal: en cada iteración, o bien
    // avanza en la dirección principal, o bien se desvía lateralmente —
    // nunca las dos cosas en el mismo paso. Así cada tile de río consecutivo
    // comparte un borde real con el anterior, que es lo que asumen las
    // piezas direccionales del autotiling (texturaRio en PantallaJuego.tsx).
    //
    // Los desvíos solo se permiten después de un mínimo de pasos rectos
    // seguidos (MIN_TRAMO_RECTO): sin este freno, cada paso decide sin
    // memoria del anterior y el desvío promedio cae cada ~3 tiles, casi
    // siempre uno solo antes de volver — se ve como un "pinchazo y vuelta"
    // constante (una esquina redondeada cada pocos tiles) en vez de tramos
    // rectos largos con curvas ocasionales bien espaciadas.
    const puedeDesviar = pasosDesdeUltimoDesvio >= MIN_TRAMO_RECTO;
    const desvia = puedeDesviar && Math.random() < 0.4;
    const delta = desvia
      ? { x: perpendicular.x * signoAleatorio(), y: perpendicular.y * signoAleatorio() }
      : direccion;
    pasosDesdeUltimoDesvio = desvia ? 0 : pasosDesdeUltimoDesvio + 1;
    // El ensanche solo se permite en el primer tramo (antes del primer
    // giro), nunca más después: `perpendicular` es fija para todo el río,
    // así que una fila paralela en un tramo posterior al giro puede caer
    // sobre un carril anterior del mismo río y crear una reconexión
    // accidental — un lazo cerrado que se ve como "dos ríos en paralelo"
    // cuando en realidad es el mismo. Ensanchar solo antes de girar por
    // primera vez evita ese solape por construcción.
    if (desvia) tramoActualEsAncho = false;
    actual = { x: actual.x + delta.x, y: actual.y + delta.y };
  }
}

const DIAGONALES: Coord[] = [
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

// Con numRios independientes (cada uno un random walk sin conocimiento de
// los demás), es común que dos tramos de ríos distintos terminen a un paso
// DIAGONAL uno del otro sin llegar a compartir un borde cardinal — el
// autotiling (cardinal-only, ver texturaRio en PantallaJuego.tsx) los
// dibuja entonces como dos remates "fin" sueltos, uno pegado al otro sin
// conectar, en vez de una curva continua. Se "sana" tendiendo un puente:
// para cada tile de río con 0-1 vecinos cardinales que tenga un vecino
// diagonal también de río EN UNA COMPONENTE CONECTADA DISTINTA, se
// convierte una de las dos esquinas que completarían el camino cardinal
// entre ambos.
//
// El chequeo de componente distinta es clave: si las dos puntas ya están
// conectadas por un camino cardinal más largo (mismo río, que solo
// serpentea cerca de sí mismo), agregar un puente directo no une nada
// nuevo — crea un atajo que se ve como una rama corta artificial pegada
// al costado del río (confirmado visualmente: así se veía el bug antes de
// este chequeo).
function sanarUnionesDiagonales(indice: Map<string, TileBioma>): boolean {
  let cambio = false;
  const rioTiles = Array.from(indice.values()).filter((t) => t.tipo === 'rio');

  const padre = new Map<string, string>();
  function raiz(clave: string): string {
    let actual = clave;
    while (padre.get(actual) !== actual) {
      const siguiente = padre.get(actual)!;
      padre.set(actual, padre.get(siguiente) ?? siguiente);
      actual = siguiente;
    }
    return actual;
  }
  function unir(a: string, b: string) {
    const ra = raiz(a);
    const rb = raiz(b);
    if (ra !== rb) padre.set(ra, rb);
  }
  for (const t of rioTiles) padre.set(claveCoord(t), claveCoord(t));
  for (const t of rioTiles) {
    for (const d of CARDINALES) {
      const claveVecino = claveCoord({ x: t.x + d.x, y: t.y + d.y });
      if (indice.get(claveVecino)?.tipo === 'rio') unir(claveCoord(t), claveVecino);
    }
  }

  for (const t of rioTiles) {
    const claveT = claveCoord(t);
    const vecinosCardinales = CARDINALES.filter(
      (d) => indice.get(claveCoord({ x: t.x + d.x, y: t.y + d.y }))?.tipo === 'rio'
    ).length;
    if (vecinosCardinales > 1) continue;

    for (const d of DIAGONALES) {
      const claveDiag = claveCoord({ x: t.x + d.x, y: t.y + d.y });
      const vecinoDiag = indice.get(claveDiag);
      if (vecinoDiag?.tipo !== 'rio') continue;
      if (raiz(claveT) === raiz(claveDiag)) continue; // ya conectados por otro camino: no es un near-miss real

      const esquinaA = indice.get(claveCoord({ x: t.x + d.x, y: t.y }));
      const esquinaB = indice.get(claveCoord({ x: t.x, y: t.y + d.y }));
      const candidato = [esquinaA, esquinaB].find((c) => c?.tipo === 'arena');
      if (candidato) {
        const claveCandidato = claveCoord(candidato);
        candidato.tipo = 'rio';
        cambio = true;
        padre.set(claveCandidato, claveCandidato);
        unir(claveCandidato, claveT);
        unir(claveCandidato, claveDiag);
        break;
      }
    }
  }
  return cambio;
}

function marcarSiExiste(indice: Map<string, TileBioma>, coord: Coord, tipo: string) {
  const tile = indice.get(claveCoord(coord));
  if (tile) tile.tipo = tipo;
}

function despejarRadio(indice: Map<string, TileBioma>, centro: Coord, radio: number) {
  for (const coord of coordsEnRadio(centro, radio)) {
    const tile = indice.get(claveCoord(coord));
    if (tile) tile.tipo = 'arena';
  }
}

function hayConectividad(n: number, tiles: TileBioma[], spawn: Coord, portal: Coord): boolean {
  const indice = new Map(tiles.map((t) => [claveCoord(t), t]));
  const claveObjetivo = claveCoord(portal);
  const visitado = new Set<string>([claveCoord(spawn)]);
  const cola: Coord[] = [spawn];

  while (cola.length > 0) {
    const actual = cola.shift()!;
    if (claveCoord(actual) === claveObjetivo) return true;
    for (const vecino of vecinos(actual)) {
      if (!dentroDelGrid(vecino, n)) continue;
      const clave = claveCoord(vecino);
      if (visitado.has(clave)) continue;
      const tile = indice.get(clave);
      if (tile && esTransitable(tile)) {
        visitado.add(clave);
        cola.push(vecino);
      }
    }
  }
  return visitado.has(claveObjetivo);
}

// 0-1 BFS: encuentra el camino que cruza la menor cantidad de obstáculos
// posible (costo 0 = transitable, costo 1 = obstáculo) y lo despeja.
function tallarCaminoMinimo(
  n: number,
  tiles: TileBioma[],
  spawn: Coord,
  portal: Coord
): TileBioma[] {
  const indice = new Map(tiles.map((t) => [claveCoord(t), t]));
  const claveInicio = claveCoord(spawn);
  const clavePortal = claveCoord(portal);

  const distancia = new Map<string, number>([[claveInicio, 0]]);
  const anterior = new Map<string, string>();
  const coordDe = new Map<string, Coord>([[claveInicio, spawn]]);
  const deque: string[] = [claveInicio];

  while (deque.length > 0) {
    const claveActual = deque.shift()!;
    const actual = coordDe.get(claveActual)!;
    const distActual = distancia.get(claveActual)!;

    for (const vecino of vecinos(actual)) {
      if (!dentroDelGrid(vecino, n)) continue;
      const claveVecino = claveCoord(vecino);
      const tile = indice.get(claveVecino);
      const costo = tile && esTransitable(tile) ? 0 : 1;
      const distVecino = distActual + costo;
      if (distVecino < (distancia.get(claveVecino) ?? Infinity)) {
        distancia.set(claveVecino, distVecino);
        anterior.set(claveVecino, claveActual);
        coordDe.set(claveVecino, vecino);
        if (costo === 0) deque.unshift(claveVecino);
        else deque.push(claveVecino);
      }
    }
  }

  let clave: string | undefined = clavePortal;
  while (clave && clave !== claveInicio) {
    const tile = indice.get(clave);
    if (tile && !esTransitable(tile)) tile.tipo = 'arena';
    clave = anterior.get(clave);
  }

  return tiles;
}

function aleatorioEntero(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function signoAleatorio(): 1 | -1 {
  return Math.random() < 0.5 ? 1 : -1;
}

function elegir<T>(opciones: readonly T[]): T {
  return opciones[aleatorioEntero(0, opciones.length - 1)];
}

function dentroDelGrid(coord: Coord, n: number): boolean {
  return coord.x >= 0 && coord.x < n && coord.y >= 0 && coord.y < n;
}
