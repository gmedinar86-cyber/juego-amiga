// Grid cuadrado (x, y) dibujado en proyección isométrica.
// pantallaX = (x - y) * (anchoTile / 2)
// pantallaY = (x + y) * (altoTile / 2)

export interface Coord {
  x: number;
  y: number;
}

// 8 direcciones (ortogonales + diagonales).
const DIRECCIONES: Coord[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

export function claveCoord(c: Coord): string {
  return `${c.x},${c.y}`;
}

export function coordsIguales(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

export function vecinos(c: Coord): Coord[] {
  return DIRECCIONES.map((d) => ({ x: c.x + d.x, y: c.y + d.y }));
}

// Distancia correcta para adyacencia de 8 direcciones (un vecino diagonal
// también está a distancia 1).
export function distanciaChebyshev(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// Con Chebyshev, el radio es un cuadrado completo (no hace falta recortar
// por fila como con Manhattan).
export function coordsEnRadio(centro: Coord, radio: number): Coord[] {
  const resultado: Coord[] = [];
  for (let dx = -radio; dx <= radio; dx++) {
    for (let dy = -radio; dy <= radio; dy++) {
      resultado.push({ x: centro.x + dx, y: centro.y + dy });
    }
  }
  return resultado;
}

export function isoAPixel(c: Coord, anchoTile: number, altoTile: number): { x: number; y: number } {
  return {
    x: (c.x - c.y) * (anchoTile / 2),
    y: (c.x + c.y) * (altoTile / 2),
  };
}

// Inversa de isoAPixel: de un punto en pixeles isométricos a coordenadas de
// grid (redondeadas al tile más cercano). Se usa para ubicar a qué tile
// corresponde un toque de Gesture.Tap, que solo da el punto en pantalla.
export function pixelAGrid(px: number, py: number, anchoTile: number, altoTile: number): Coord {
  const a = px / (anchoTile / 2); // = x - y
  const b = py / (altoTile / 2); // = x + y
  return { x: Math.round((a + b) / 2), y: Math.round((b - a) / 2) };
}

export function esquinasRombo(cx: number, cy: number, anchoTile: number, altoTile: number): string {
  const puntos = [
    { x: cx, y: cy - altoTile / 2 },
    { x: cx + anchoTile / 2, y: cy },
    { x: cx, y: cy + altoTile / 2 },
    { x: cx - anchoTile / 2, y: cy },
  ];
  return puntos.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

// Clave de orden de pintado (pintor's algorithm): a menor x+y, más "atrás".
export function claveProfundidad(c: Coord): number {
  return c.x + c.y;
}
