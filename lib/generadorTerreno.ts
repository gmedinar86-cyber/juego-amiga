import { claveCoord, coordsEnRadio, vecinos, type Coord } from './isoGrid';
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

  despejarRadio(indice, spawn, 2);
  despejarRadio(indice, portal, 2);

  const tilePortal = indice.get(claveCoord(portal));
  if (tilePortal) tilePortal.tipo = 'portal';

  return tiles;
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

function generarRio(n: number, indice: Map<string, TileBioma>) {
  const lado = elegir(LADOS);

  let pos: Coord;
  let direccion: Coord;
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

  const longitud = aleatorioEntero(Math.round(n * 0.5), Math.round(n * 1.0));
  const dosCasillasDeAncho = Math.random() < 0.3;
  const perpendicular: Coord = direccion.x !== 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };

  let actual = { ...pos };
  for (let i = 0; i < longitud; i++) {
    if (!dentroDelGrid(actual, n)) break;
    marcarSiExiste(indice, actual, 'rio');
    if (dosCasillasDeAncho) {
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
    // 70% avanza / 30% desvío lateral: mantiene el río progresando hacia el
    // lado opuesto sin perder la curvatura.
    const avanza = Math.random() < 0.7;
    const delta = avanza
      ? direccion
      : { x: perpendicular.x * signoAleatorio(), y: perpendicular.y * signoAleatorio() };
    actual = { x: actual.x + delta.x, y: actual.y + delta.y };
  }
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
