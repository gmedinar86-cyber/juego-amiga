import { claveCoord, coordsIguales, vecinos, type Coord } from './isoGrid';
import { esTransitable } from './generadorTerreno';
import type { TileBioma } from './tipos';

// BFS: el costo de moverse entre casillas transitables es uniforme, así que
// alcanza con BFS para el camino más corto (no hace falta A*).
// Devuelve los pasos desde `origen` (sin incluirlo) hasta `destino`
// (incluido), o null si no existe camino transitable.
//
// `esTransitableFn` es reemplazable para contextos donde la transitabilidad
// no depende solo del tile en sí: un río con puente construido cuenta como
// transitable para ese jugador, y al escalar una montaña el predicado se
// restringe a solo tiles 'montana' (ver PantallaJuego.tsx). Por defecto usa
// la regla genérica de generadorTerreno.ts.
export function encontrarCamino(
  origen: Coord,
  destino: Coord,
  tilesPorClave: Map<string, TileBioma>,
  esTransitableFn: (tile: TileBioma) => boolean = esTransitable
): Coord[] | null {
  if (coordsIguales(origen, destino)) return [];

  const tileDestino = tilesPorClave.get(claveCoord(destino));
  if (!tileDestino || !esTransitableFn(tileDestino)) return null;

  const visitado = new Set<string>([claveCoord(origen)]);
  const anterior = new Map<string, Coord>();
  const cola: Coord[] = [origen];

  while (cola.length > 0) {
    const actual = cola.shift()!;
    if (coordsIguales(actual, destino)) {
      const camino: Coord[] = [];
      let paso: Coord | undefined = destino;
      while (paso && !coordsIguales(paso, origen)) {
        camino.unshift(paso);
        paso = anterior.get(claveCoord(paso));
      }
      return camino;
    }

    for (const vecino of vecinos(actual)) {
      const clave = claveCoord(vecino);
      if (visitado.has(clave)) continue;
      const tile = tilesPorClave.get(clave);
      if (!tile || !esTransitableFn(tile)) continue;
      visitado.add(clave);
      anterior.set(clave, actual);
      cola.push(vecino);
    }
  }

  return null;
}

// BFS acotado por profundidad (no por distancia geométrica): revela solo
// casillas realmente alcanzables caminando desde `centro` dentro de `radio`
// pasos, en vez de un cuadrado Chebyshev sin filtrar (que ignoraría ríos y
// montañas de por medio). Una casilla no transitable SÍ queda visible (se
// agrega al resultado, para que se vea como "pared") pero no se usa para
// seguir expandiendo la búsqueda más allá de ella. Sin obstáculos de por
// medio, da exactamente el mismo resultado que un radio Chebyshev normal.
export function tilesAlcanzables(
  centro: Coord,
  radio: number,
  tilesPorClave: Map<string, TileBioma>,
  esTransitableFn: (tile: TileBioma) => boolean = esTransitable
): Coord[] {
  const claveCentro = claveCoord(centro);
  const visitado = new Map<string, Coord>([[claveCentro, centro]]);
  const cola: { coord: Coord; distancia: number }[] = [{ coord: centro, distancia: 0 }];

  while (cola.length > 0) {
    const { coord, distancia } = cola.shift()!;
    if (distancia >= radio) continue;

    const tile = tilesPorClave.get(claveCoord(coord));
    if (!tile || !esTransitableFn(tile)) continue;

    for (const vecino of vecinos(coord)) {
      const clave = claveCoord(vecino);
      if (visitado.has(clave)) continue;
      if (!tilesPorClave.has(clave)) continue;
      visitado.set(clave, vecino);
      cola.push({ coord: vecino, distancia: distancia + 1 });
    }
  }

  return Array.from(visitado.values());
}
