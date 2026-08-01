import { claveCoord, coordsIguales, vecinos, type Coord } from './isoGrid';
import { esTransitable } from './generadorTerreno';
import type { TileBioma } from './tipos';

// BFS: el costo de moverse entre casillas transitables es uniforme, así que
// alcanza con BFS para el camino más corto (no hace falta A*).
// Devuelve los pasos desde `origen` (sin incluirlo) hasta `destino`
// (incluido), o null si no existe camino transitable.
export function encontrarCamino(
  origen: Coord,
  destino: Coord,
  tilesPorClave: Map<string, TileBioma>
): Coord[] | null {
  if (coordsIguales(origen, destino)) return [];

  const tileDestino = tilesPorClave.get(claveCoord(destino));
  if (!tileDestino || !esTransitable(tileDestino)) return null;

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
      if (!tile || !esTransitable(tile)) continue;
      visitado.add(clave);
      anterior.set(clave, actual);
      cola.push(vecino);
    }
  }

  return null;
}
