import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, G, Image as ImagenSvg, Path, Polygon, Polyline } from 'react-native-svg';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import {
  claveCoord,
  claveProfundidad,
  esquinasRombo,
  isoAPixel,
  pixelAGrid,
  vecinos,
  type Coord,
} from '../lib/isoGrid';
import { encontrarCamino, tilesAlcanzables } from '../lib/pathfinding';
import { herramientaParaRecurso, objetoParaRecurso, recursosHabilitados as calcularRecursosHabilitados } from '../lib/objetos';
import type { Bioma, DescubrimientoJugador, InventarioItem, Objeto, ProgresoJugador, TileBioma } from '../lib/tipos';

const RADIO_VISION_DEFAULT = 1;
const RADIO_VISION_MONTANA = 3;
const DURACION_PASO_MS = 200;
const SIN_CAMINO_FLASH_MS = 350;
const MENSAJE_ACCION_MS = 1800;
const ANCHO_TILE = 72;
const ALTO_TILE = 36;
const CAMARA_RADIO = 2.5;
const SEMI_ANCHO_BASE = CAMARA_RADIO * ANCHO_TILE;
const SEMI_ALTO_BASE = CAMARA_RADIO * ALTO_TILE;
const ZOOM_MIN_ABSOLUTO = 0.05;
const ZOOM_MAX = 2.5;
const MARGEN_ZOOM_ALEJADO = 1.15;

// Placeholder visual: sprite frontal (no isométrico), solo para tener idea
// de cómo se verá el personaje — no está pensado para encajar perfecto en
// la perspectiva del mapa.
const SPRITE_JUGADOR = require('../assets/personajes/maga-fuego-sprite.png');
const SPRITE_ASPECTO = 628 / 1289; // ancho/alto del PNG original
const SPRITE_ALTO = ALTO_TILE * 1.6;
const SPRITE_ANCHO = SPRITE_ALTO * SPRITE_ASPECTO;

// Texturas de tile del bioma desierto: bloques isométricos con paredes
// laterales (no rombos planos), fondo transparente. Se anclan por el borde
// superior en el mismo vértice que ya usa el rombo plano (pixel.y -
// ALTO_TILE/2) y el ancho se fija en ANCHO_TILE para que las caras
// superiores calcen entre tiles vecinos — el alto sale de la proporción
// real de cada PNG, así que las que tienen decoración (montaña, cactus)
// salen más altas sin estirar la imagen.
interface Textura {
  fuente: number;
  alto: number; // ya resuelto en px: ANCHO_TILE / aspectoOriginal
  // Transform SVG adicional aplicado después de translate(pixel.x,pixel.y)
  // — solo lo usan las piezas de río autotileadas (espejado/rotación).
  transform?: string;
  // Si es true, la Image se ancla centrada en el tile en vez de por el
  // borde superior (excepción para las piezas de esquina rotadas — ver
  // orientarEsquina).
  centrado?: boolean;
}

function crearTextura(fuente: number, anchoOriginal: number, altoOriginal: number): Textura {
  return { fuente, alto: ANCHO_TILE / (anchoOriginal / altoOriginal) };
}

const TEXTURA_ARENA = crearTextura(require('../assets/tiles/sand.png'), 263, 199);
// river.png (el tile de río plano original) queda sin usar — reemplazado
// por el sistema de autotiling de abajo. El archivo se deja en el repo por
// si sirve para otra cosa más adelante.
const TEXTURA_OASIS = crearTextura(require('../assets/tiles/oasis.png'), 263, 243);
const TEXTURA_MONTANA = crearTextura(require('../assets/tiles/mountain.png'), 265, 243);
const TEXTURA_ARBOL_SECO = crearTextura(require('../assets/tiles/dead-tree.png'), 263, 278);
const TEXTURA_CACTUS = crearTextura(require('../assets/tiles/cactus.png'), 263, 312);

// Variedad en 'montana': hash determinístico por coordenada del propio tile
// (no Math.random(), para que no titile en cada render) — 60% montaña rocosa,
// 20% árbol seco, 20% cactus, como acento disperso en vez de franjas parejas.
function texturaMontana(tile: TileBioma): Textura {
  const hash = Math.abs(tile.x * 928371 + tile.y * 543217) % 10;
  if (hash < 6) return TEXTURA_MONTANA;
  if (hash < 8) return TEXTURA_ARBOL_SECO;
  return TEXTURA_CACTUS;
}

// --- Río: autotiling con piezas direccionales ---
//
// Solo se consideran los 4 vecinos CARDINALES de grid (no los 4 diagonales):
// un paso cardinal (ej. (1,0)) comparte un borde completo del rombo con el
// vecino; un paso diagonal solo toca un vértice, sin borde que "cruce". El
// generador de terreno además sella la celda esquina cada vez que el río da
// un paso diagonal (ver generarRio), así que en la práctica los ríos
// generados quedan conectados por bordes cardinales de todas formas.
type Borde = 'NE' | 'SE' | 'SW' | 'NW';

const BORDE_DELTA: Record<Borde, Coord> = {
  NE: { x: 0, y: -1 },
  SE: { x: 1, y: 0 },
  SW: { x: 0, y: 1 },
  NW: { x: -1, y: 0 },
};

// Signo en pantalla de cada borde (a partir de isoAPixel del delta) — deja
// resolver espejados comparando signos en vez de razonar en coordenadas de
// grid, que no están alineadas con los ejes de pantalla en esta proyección.
const BORDE_SIGNO: Record<Borde, { sx: 1 | -1; sy: 1 | -1 }> = {
  NE: { sx: 1, sy: -1 },
  SE: { sx: 1, sy: 1 },
  SW: { sx: -1, sy: 1 },
  NW: { sx: -1, sy: -1 },
};

function sonOpuestos(a: Borde, b: Borde): boolean {
  return (a === 'NE' && b === 'SW') || (a === 'SW' && b === 'NE') || (a === 'NW' && b === 'SE') || (a === 'SE' && b === 'NW');
}

type Vertice = 'ARRIBA' | 'DERECHA' | 'ABAJO' | 'IZQUIERDA';

const VERTICE_BORDES: Record<Vertice, [Borde, Borde]> = {
  ARRIBA: ['NE', 'NW'],
  DERECHA: ['NE', 'SE'],
  ABAJO: ['SE', 'SW'],
  IZQUIERDA: ['SW', 'NW'],
};

// Dirección de cada vértice en pantalla — ARRIBA/ABAJO son "familia
// vertical" (x=0), DERECHA/IZQUIERDA son "familia horizontal" (y=0). Pasar
// de una familia a la otra es lo único que no se puede resolver con
// espejado en un rombo 2:1 (ver orientarEsquina).
const VERTICE_DIRECCION: Record<Vertice, { x: number; y: number }> = {
  ARRIBA: { x: 0, y: -1 },
  DERECHA: { x: 1, y: 0 },
  ABAJO: { x: 0, y: 1 },
  IZQUIERDA: { x: -1, y: 0 },
};

const ORDEN_VERTICES: Vertice[] = ['ARRIBA', 'DERECHA', 'ABAJO', 'IZQUIERDA'];

function verticeDesdeBordes(a: Borde, b: Borde): Vertice {
  const entrada = (Object.entries(VERTICE_BORDES) as [Vertice, [Borde, Borde]][]).find(
    ([, bordes]) => bordes.includes(a) && bordes.includes(b)
  );
  return entrada![0];
}

const TEXTURA_RIO_RECTO_NESW = crearTextura(require('../assets/tiles/recto-nesw.png'), 226, 168);
const TEXTURA_RIO_RECTO_NWSE = crearTextura(require('../assets/tiles/recto-nwse.png'), 226, 168);
const TEXTURA_RIO_ESQUINA = crearTextura(require('../assets/tiles/esquina.png'), 226, 166);
const TEXTURA_RIO_CONFLUENCIA = crearTextura(require('../assets/tiles/confluencia-4.png'), 226, 168);
const TEXTURA_RIO_ANCHO = crearTextura(require('../assets/tiles/ancho.png'), 226, 167);
const TEXTURA_RIO_FIN = crearTextura(require('../assets/tiles/fin.png'), 238, 206);

// Orientación asumida de cada pieza tal como está dibujada — lectura visual
// aproximada. Si alguna pieza sale rotada/espejada al revés en el
// dispositivo, ajustar estos 3 valores (única fuente de verdad de la
// orientación base, no hace falta tocar la lógica de abajo).
const FIN_BASE: Borde = 'NE';
const ANCHO_BASE_CERRADO: Borde = 'NW'; // el único borde sin agua en ancho.png
const ESQUINA_BASE_VERTICE: Vertice = 'ABAJO';

// Aplica un espejado "en el lugar" (preserva el anclaje por borde superior)
// — si no hace falta espejar, no agrega transform.
function piezaPlano(base: Textura, escalaX: 1 | -1 = 1, escalaY: 1 | -1 = 1): Textura {
  if (escalaX === 1 && escalaY === 1) return { fuente: base.fuente, alto: base.alto };
  const centroY = -ALTO_TILE / 2 + base.alto / 2;
  return {
    fuente: base.fuente,
    alto: base.alto,
    transform: `translate(0,${centroY}) scale(${escalaX},${escalaY}) translate(0,${-centroY})`,
  };
}

// Rotación de 90°/-90° + escala compensatoria para que la huella final
// siga midiendo ANCHO_TILE x alto — aproximación aceptada (distorsiona la
// pieza) para las 2 de las 4 orientaciones de esquina que un espejado no
// puede alcanzar en un rombo 2:1. Se ancla centrada en el tile en vez de
// por el borde superior.
function piezaRotada(base: Textura, angulo: 90 | -90): Textura {
  const escalaCompX = base.alto / ANCHO_TILE;
  const escalaCompY = ANCHO_TILE / base.alto;
  return {
    fuente: base.fuente,
    alto: base.alto,
    transform: `rotate(${angulo}) scale(${escalaCompX},${escalaCompY})`,
    centrado: true,
  };
}

function orientarFin(objetivo: Borde): Textura {
  const base = BORDE_SIGNO[FIN_BASE];
  const obj = BORDE_SIGNO[objetivo];
  return piezaPlano(TEXTURA_RIO_FIN, (obj.sx * base.sx) as 1 | -1, (obj.sy * base.sy) as 1 | -1);
}

function orientarAncho(bordeCerrado: Borde): Textura {
  const base = BORDE_SIGNO[ANCHO_BASE_CERRADO];
  const obj = BORDE_SIGNO[bordeCerrado];
  return piezaPlano(TEXTURA_RIO_ANCHO, (obj.sx * base.sx) as 1 | -1, (obj.sy * base.sy) as 1 | -1);
}

function orientarEsquina(objetivo: Vertice): Textura {
  if (objetivo === ESQUINA_BASE_VERTICE) return piezaPlano(TEXTURA_RIO_ESQUINA);

  const idxBase = ORDEN_VERTICES.indexOf(ESQUINA_BASE_VERTICE);
  const idxObjetivo = ORDEN_VERTICES.indexOf(objetivo);
  const diff = (idxObjetivo - idxBase + 4) % 4;

  if (diff === 2) {
    // Misma familia (arriba<->abajo o izquierda<->derecha): espejado exacto.
    const base = VERTICE_DIRECCION[ESQUINA_BASE_VERTICE];
    const obj = VERTICE_DIRECCION[objetivo];
    const escalaX = base.x === 0 ? 1 : ((obj.x * base.x) as 1 | -1);
    const escalaY = base.y === 0 ? 1 : ((obj.y * base.y) as 1 | -1);
    return piezaPlano(TEXTURA_RIO_ESQUINA, escalaX, escalaY);
  }

  // diff 1 o 3: familias distintas — necesita la rotación aproximada.
  return piezaRotada(TEXTURA_RIO_ESQUINA, diff === 1 ? 90 : -90);
}

function texturaRio(tile: TileBioma, tilesPorClave: Map<string, TileBioma>): Textura {
  const conectados = (Object.keys(BORDE_DELTA) as Borde[]).filter((borde) => {
    const d = BORDE_DELTA[borde];
    return tilesPorClave.get(claveCoord({ x: tile.x + d.x, y: tile.y + d.y }))?.tipo === 'rio';
  });

  if (conectados.length === 0) return orientarFin(FIN_BASE); // aislado: no hay vecino que oriente la pieza
  if (conectados.length === 1) return orientarFin(conectados[0]);

  if (conectados.length === 2) {
    const [a, b] = conectados;
    if (sonOpuestos(a, b)) {
      const ejeY = a === 'NE' || a === 'SW';
      return piezaPlano(ejeY ? TEXTURA_RIO_RECTO_NESW : TEXTURA_RIO_RECTO_NWSE);
    }
    return orientarEsquina(verticeDesdeBordes(a, b));
  }

  if (conectados.length === 3) {
    const faltante = (Object.keys(BORDE_DELTA) as Borde[]).find((b) => !conectados.includes(b))!;
    return orientarAncho(faltante);
  }

  return piezaPlano(TEXTURA_RIO_CONFLUENCIA);
}

function texturaParaTile(
  tile: TileBioma,
  tilesPorClave: Map<string, TileBioma>,
  recolectado: boolean
): Textura | null {
  switch (tile.tipo) {
    case 'arena':
      return TEXTURA_ARENA;
    case 'rio':
      return texturaRio(tile, tilesPorClave);
    case 'oasis':
      return TEXTURA_OASIS;
    case 'montana':
      return texturaMontana(tile);
    case 'arbol':
      // Ya recolectado (madera): vuelve a verse como arena plana, igual que
      // piedra/lana cuando se juntan (ver el filtro de íconos más abajo).
      return recolectado ? TEXTURA_ARENA : TEXTURA_ARBOL_SECO;
    default:
      return null; // portal u otros tipos sin textura: sigue con colorTile
  }
}

// --- Río como cauce continuo calculado por código (ver plan) ---
const ANCHO_RIO_BASE = ALTO_TILE * 0.6;
const ANCHO_RIO_ANCHO = ANCHO_RIO_BASE * 1.6;
const RIO_BORDE_EXTRA = 6;
const COLOR_RIO_AGUA = '#2E6F8E'; // mismo azul que ya usaba colorTile('rio')
const COLOR_RIO_BORDE = '#1B4E63';

interface JuntaRio {
  tile: TileBioma;
  pixel: Coord;
  ancho: number;
}

interface TramoRio {
  a: JuntaRio;
  b: JuntaRio;
  ancho: number;
}

// Franja (quad) entre dos centros de tile, perpendicular a la dirección
// entre ellos. Junto con un círculo del mismo ancho en cada extremo (ver
// render), forma una cinta continua sin costuras en ningún ángulo.
function franjaAgua(pa: Coord, pb: Coord, ancho: number): string {
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * (ancho / 2);
  const py = (dx / len) * (ancho / 2);
  const puntos = [
    { x: pa.x + px, y: pa.y + py },
    { x: pb.x + px, y: pb.y + py },
    { x: pb.x - px, y: pb.y - py },
    { x: pa.x - px, y: pa.y - py },
  ];
  return puntos.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

// Iconos de recurso/cofre en el mapa: paths copiados de los iconos
// TreePine/Package de lucide-react-native (v1.28.0, viewBox 24x24) en vez
// de usar el componente <TreePine>/<Package> directamente — esos componentes
// se envuelven en su propio <Svg> raíz, y anidar un <Svg> dentro de otro no
// está soportado de forma fiable en nativo (react-native-svg trata <Svg>
// como una vista raíz, no un grupo liviano). Usando el path real como <G>/
// <Path> dentro del <Svg> del mapa se evita ese problema y se ve igual.
type SegmentoIcono = { tipo: 'path'; d: string } | { tipo: 'polyline'; points: string };

const ICONO_TAMANO = ALTO_TILE * 0.75;
const ICONO_VIEWBOX = 24;

const ICONO_ARBOL: SegmentoIcono[] = [
  {
    tipo: 'path',
    d: 'm17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z',
  },
  { tipo: 'path', d: 'M12 22v-3' },
];

// Placeholders (sin arte propio todavía) para piedra/lana: paths de los
// iconos lucide "Gem" (mineral) y "Cloud" (aproximación de vellón/lana),
// mismo criterio que ICONO_ARBOL/ICONO_COFRE de arriba.
const ICONO_ROCA: SegmentoIcono[] = [
  { tipo: 'path', d: 'M6 3h12l4 6-10 13L2 9Z' },
  { tipo: 'path', d: 'M11 3 8 9l4 13 4-13-3-6' },
  { tipo: 'path', d: 'M2 9h20' },
];

const ICONO_OVEJA: SegmentoIcono[] = [
  { tipo: 'path', d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' },
];

// Qué ícono/color usar para cada tipo de recurso de tile — agregar un nuevo
// recurso (data-driven, ver lib/objetos.ts) solo necesita una entrada acá.
const ICONOS_RECURSO: Record<string, { segmentos: SegmentoIcono[]; color: string }> = {
  madera: { segmentos: ICONO_ARBOL, color: '#7BC96F' },
  piedra: { segmentos: ICONO_ROCA, color: '#9AA5B1' },
  lana: { segmentos: ICONO_OVEJA, color: '#F2F2F2' },
};

const ICONO_COFRE: SegmentoIcono[] = [
  {
    tipo: 'path',
    d: 'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z',
  },
  { tipo: 'path', d: 'M12 22V12' },
  { tipo: 'polyline', points: '3.29 7 12 12 20.71 7' },
  { tipo: 'path', d: 'm7.5 4.27 9 5.15' },
];

function IconoMapa({ segmentos, x, y, color }: { segmentos: SegmentoIcono[]; x: number; y: number; color: string }) {
  const escala = ICONO_TAMANO / ICONO_VIEWBOX;
  return (
    <G transform={`translate(${x - ICONO_TAMANO / 2}, ${y - ICONO_TAMANO / 2}) scale(${escala})`}>
      {segmentos.map((s, i) =>
        s.tipo === 'path' ? (
          <Path key={i} d={s.d} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ) : (
          <Polyline
            key={i}
            points={s.points}
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        )
      )}
    </G>
  );
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// DEBUG: muestra el bioma completo sin niebla, solo para esta fase de pruebas.
// Solo afecta qué color se pinta — no toca `descubiertas` ni lo persistido en
// descubrimiento_jugador. Volver a `false` cuando dejemos de necesitarlo.
const DEBUG_SIN_FOG = true;

interface LimitesBioma {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Zoom mínimo dinámico: el necesario para que la ventana de cámara cubra
// todo el bounding box del bioma (con margen), sea cual sea su tamaño.
function calcularZoomMinimo(limites: LimitesBioma | null): number {
  if (!limites) return ZOOM_MIN_ABSOLUTO;
  const mapaAncho = limites.maxX - limites.minX;
  const mapaAlto = limites.maxY - limites.minY;
  if (mapaAncho <= 0 || mapaAlto <= 0) return ZOOM_MIN_ABSOLUTO;
  const zoomParaAncho = (2 * SEMI_ANCHO_BASE) / (mapaAncho * MARGEN_ZOOM_ALEJADO);
  const zoomParaAlto = (2 * SEMI_ALTO_BASE) / (mapaAlto * MARGEN_ZOOM_ALEJADO);
  return Math.max(Math.min(zoomParaAncho, zoomParaAlto, 1), ZOOM_MIN_ABSOLUTO);
}

function colorTile(tipo: string): string {
  switch (tipo) {
    case 'montana':
      return '#5C5348';
    case 'rio':
      return '#2E6F8E';
    case 'portal':
      return '#8B5CF6';
    case 'oasis':
      return '#2E7D6B';
    default:
      return '#B98A4A';
  }
}

function limitarOffset(propuesto: Coord, centroJugador: Coord, limites: LimitesBioma | null): Coord {
  if (!limites) return propuesto;
  const margenX = ANCHO_TILE * 1.5;
  const margenY = ALTO_TILE * 1.5;
  const minX = limites.minX - margenX - centroJugador.x;
  const maxX = limites.maxX + margenX - centroJugador.x;
  const minY = limites.minY - margenY - centroJugador.y;
  const maxY = limites.maxY + margenY - centroJugador.y;
  return {
    x: Math.min(Math.max(propuesto.x, minX), maxX),
    y: Math.min(Math.max(propuesto.y, minY), maxY),
  };
}

export default function PantallaJuego({ session }: { session: Session }) {
  const [progreso, setProgreso] = useState<ProgresoJugador | null>(null);
  const [bioma, setBioma] = useState<Bioma | null>(null);
  const [descubrimientoId, setDescubrimientoId] = useState<string | null>(null);
  const [descubiertas, setDescubiertas] = useState<Map<string, Coord>>(new Map());
  const [posicionVisual, setPosicionVisual] = useState<Coord>({ x: 0, y: 0 });
  const [casillaSinCamino, setCasillaSinCamino] = useState<string | null>(null);
  const [caminando, setCaminando] = useState(false);
  const [catalogoObjetos, setCatalogoObjetos] = useState<Map<string, Objeto>>(new Map());
  const [inventario, setInventario] = useState<InventarioItem[]>([]);
  const [cofresAbiertos, setCofresAbiertos] = useState<Map<string, Coord>>(new Map());
  const [recursosRecolectados, setRecursosRecolectados] = useState<Map<string, Coord>>(new Map());
  const [inventarioVisible, setInventarioVisible] = useState(false);
  const [mensajeAccion, setMensajeAccion] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [cameraOffset, setCameraOffset] = useState<Coord>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [tamanoContenedor, setTamanoContenedor] = useState({ width: 0, height: 0 });

  // Refs con el valor más reciente de cada estado, para leerlos desde los
  // callbacks de gestos sin recrear los gestos (y sin depender de Reanimated).
  const cameraOffsetRef = useRef(cameraOffset);
  const zoomRef = useRef(zoom);
  const progresoRef = useRef(progreso);
  const limitesRef = useRef<LimitesBioma | null>(null);
  const zoomMinRef = useRef(ZOOM_MIN_ABSOLUTO);
  const tamanoRef = useRef(tamanoContenedor);
  const offsetInicioGesto = useRef({ x: 0, y: 0 });
  const zoomInicioGesto = useRef(1);
  // tilesPorClaveRef e iniciarCaminoHaciaRef: gestoTap se crea una sola vez
  // (useMemo con deps []), así que cualquier valor que lea desde adentro
  // tiene que venir de un ref actualizado, no de la variable/función del
  // render en el que se creó — si no, quedaría pegado al Map vacío y al
  // iniciarCaminoHacia con progreso/bioma en null del primer render.
  const tilesPorClaveRef = useRef<Map<string, TileBioma>>(new Map());
  const iniciarCaminoHaciaRef = useRef<(destino: Coord) => void>(() => {});

  // Estado del caminar por pathfinding. posicionVisualRef es la fuente única
  // de verdad de la posición mientras se anima entre casillas — se actualiza
  // de forma síncrona en cada frame (no vía efecto), para que una cadena de
  // pasos encadenados nunca lea una posición vieja. colaRef guarda el camino
  // restante, incluida la casilla hacia la que ya se está animando (se
  // descarta recién cuando esa animación termina).
  const posicionVisualRef = useRef<Coord>({ x: 0, y: 0 });
  const descubiertasRef = useRef<Map<string, Coord>>(new Map());
  const colaRef = useRef<Coord[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const sinCaminoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mensajeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cameraOffsetRef.current = cameraOffset;
  }, [cameraOffset]);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    progresoRef.current = progreso;
  }, [progreso]);
  useEffect(() => {
    tamanoRef.current = tamanoContenedor;
  }, [tamanoContenedor]);

  useEffect(() => {
    cargarPartida();
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      if (sinCaminoTimeoutRef.current) clearTimeout(sinCaminoTimeoutRef.current);
      if (mensajeTimeoutRef.current) clearTimeout(mensajeTimeoutRef.current);
    };
  }, []);

  // Proyección isométrica de cada tile calculada una sola vez por bioma (no en
  // cada frame de cámara) — la base del culling de rendimiento con mapas grandes.
  const pixelesBioma = useMemo(() => {
    if (!bioma) return [];
    return bioma.tiles.tiles.map((tile) => ({ tile, pixel: isoAPixel(tile, ANCHO_TILE, ALTO_TILE) }));
  }, [bioma]);

  const tilesPorClave = useMemo(() => {
    const mapa = new Map<string, TileBioma>();
    if (!bioma) return mapa;
    for (const tile of bioma.tiles.tiles) mapa.set(claveCoord(tile), tile);
    return mapa;
  }, [bioma]);

  useEffect(() => {
    tilesPorClaveRef.current = tilesPorClave;
  }, [tilesPorClave]);

  // Geometría del río: se calcula una sola vez por bioma (datos estáticos de
  // terreno, no dependen de la posición del jugador). juntas = un círculo por
  // cada tile de río; tramos = una franja por cada par de tiles de río
  // adyacentes (8 direcciones), sin duplicar el par. El ancho por tile sale
  // de cuántos vecinos también son río: más de 2 vecinos-río (las zonas
  // donde el generador ya puso dos filas paralelas, o confluencias) dan un
  // tramo más ancho; si no, ancho base.
  const rioGeometria = useMemo(() => {
    if (!bioma) return { juntas: [] as JuntaRio[], tramos: [] as TramoRio[] };

    const rioTiles = bioma.tiles.tiles.filter((t) => t.tipo === 'rio');

    function anchoLocal(tile: TileBioma): number {
      const vecinosRio = vecinos(tile).filter((v) => tilesPorClave.get(claveCoord(v))?.tipo === 'rio').length;
      return vecinosRio > 2 ? ANCHO_RIO_ANCHO : ANCHO_RIO_BASE;
    }

    const juntas: JuntaRio[] = rioTiles.map((tile) => ({
      tile,
      pixel: isoAPixel(tile, ANCHO_TILE, ALTO_TILE),
      ancho: anchoLocal(tile),
    }));
    const juntaPorClave = new Map(juntas.map((j) => [claveCoord(j.tile), j]));

    const tramos: TramoRio[] = [];
    const procesados = new Set<string>();
    for (const junta of juntas) {
      for (const vecino of vecinos(junta.tile)) {
        const juntaVecino = juntaPorClave.get(claveCoord(vecino));
        if (!juntaVecino) continue;
        const parClave = [claveCoord(junta.tile), claveCoord(vecino)].sort().join('|');
        if (procesados.has(parClave)) continue;
        procesados.add(parClave);
        tramos.push({ a: junta, b: juntaVecino, ancho: Math.min(junta.ancho, juntaVecino.ancho) });
      }
    }

    return { juntas, tramos };
  }, [bioma, tilesPorClave]);

  function fusionarDescubiertas(
    actuales: Map<string, Coord>,
    centro: Coord,
    tilesPorClaveBioma: Map<string, TileBioma>,
    radio: number = RADIO_VISION_DEFAULT
  ): Map<string, Coord> {
    const resultado = new Map(actuales);
    for (const c of tilesAlcanzables(centro, radio, tilesPorClaveBioma)) {
      resultado.set(claveCoord(c), c);
    }
    return resultado;
  }

  async function cargarPartida() {
    setCargando(true);
    setError(null);
    try {
      let { data: progresoData, error: errProgreso } = await supabase
        .from('progreso_jugador')
        .select('*')
        .eq('usuario_id', session.user.id)
        .maybeSingle();
      if (errProgreso) throw errProgreso;

      if (!progresoData) {
        const { data: biomaInicial, error: errBioma } = await supabase
          .from('biomas')
          .select('id, tiles')
          .order('creado_en', { ascending: true })
          .limit(1)
          .maybeSingle<Pick<Bioma, 'id' | 'tiles'>>();
        if (errBioma) throw errBioma;
        if (!biomaInicial) throw new Error('No hay ningún bioma creado todavía en Supabase.');

        const spawn = biomaInicial.tiles.spawn;
        const { data: nuevoProgreso, error: errInsert } = await supabase
          .from('progreso_jugador')
          .insert({
            usuario_id: session.user.id,
            bioma_actual_id: biomaInicial.id,
            posicion_q: spawn.x,
            posicion_r: spawn.y,
          })
          .select()
          .single();
        if (errInsert) throw errInsert;
        progresoData = nuevoProgreso;
      }

      if (!progresoData.bioma_actual_id) {
        throw new Error('El jugador no tiene un bioma asignado.');
      }

      const { data: biomaData, error: errBioma2 } = await supabase
        .from('biomas')
        .select('*')
        .eq('id', progresoData.bioma_actual_id)
        .single();
      if (errBioma2) throw errBioma2;

      const { data: descData, error: errDesc } = await supabase
        .from('descubrimiento_jugador')
        .select('*')
        .eq('usuario_id', session.user.id)
        .eq('bioma_id', progresoData.bioma_actual_id)
        .maybeSingle<DescubrimientoJugador>();
      if (errDesc) throw errDesc;

      const posicionActual: Coord = { x: progresoData.posicion_q, y: progresoData.posicion_r };
      const previas = new Map<string, Coord>(
        (descData?.casillas_descubiertas ?? []).map((c) => [claveCoord(c), c])
      );
      // tilesPorClave (el useMemo del componente) todavía no existe en este
      // punto porque `bioma` recién se setea más abajo — armamos el mapa
      // local solo para esta llamada inicial.
      const tilesPorClaveInicial = new Map<string, TileBioma>(
        biomaData.tiles.tiles.map((t: TileBioma) => [claveCoord(t), t])
      );
      const reveladas = fusionarDescubiertas(previas, posicionActual, tilesPorClaveInicial);

      let descFinal: DescubrimientoJugador;
      if (descData) {
        setDescubrimientoId(descData.id);
        if (reveladas.size !== previas.size) {
          await supabase
            .from('descubrimiento_jugador')
            .update({ casillas_descubiertas: Array.from(reveladas.values()) })
            .eq('id', descData.id);
        }
        descFinal = descData;
      } else {
        const { data: nuevoDesc, error: errNuevoDesc } = await supabase
          .from('descubrimiento_jugador')
          .insert({
            usuario_id: session.user.id,
            bioma_id: progresoData.bioma_actual_id,
            casillas_descubiertas: Array.from(reveladas.values()),
          })
          .select()
          .single();
        if (errNuevoDesc) throw errNuevoDesc;
        setDescubrimientoId(nuevoDesc.id);
        descFinal = nuevoDesc;
      }

      const cofresIniciales = new Map<string, Coord>(
        (descFinal.cofres_abiertos ?? []).map((c) => [claveCoord(c), c])
      );
      const recursosIniciales = new Map<string, Coord>(
        (descFinal.recursos_recolectados ?? []).map((c) => [claveCoord(c), c])
      );

      const { data: objetosData, error: errObjetos } = await supabase.from('objetos').select('*');
      if (errObjetos) throw errObjetos;
      const catalogo = new Map<string, Objeto>((objetosData ?? []).map((o) => [o.id, o as Objeto]));

      const { data: inventarioData, error: errInventario } = await supabase
        .from('inventario_jugador')
        .select('*')
        .eq('usuario_id', session.user.id);
      if (errInventario) throw errInventario;

      const posicionInicial: Coord = { x: progresoData.posicion_q, y: progresoData.posicion_r };
      posicionVisualRef.current = posicionInicial;
      descubiertasRef.current = reveladas;

      setProgreso(progresoData);
      setBioma(biomaData);
      setDescubiertas(reveladas);
      setPosicionVisual(posicionInicial);
      setCofresAbiertos(cofresIniciales);
      setRecursosRecolectados(recursosIniciales);
      setCatalogoObjetos(catalogo);
      setInventario(inventarioData ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error desconocido al cargar la partida.');
    } finally {
      setCargando(false);
    }
  }

  function mostrarSinCamino(destino: Coord) {
    const clave = claveCoord(destino);
    setCasillaSinCamino(clave);
    if (sinCaminoTimeoutRef.current) clearTimeout(sinCaminoTimeoutRef.current);
    sinCaminoTimeoutRef.current = setTimeout(() => setCasillaSinCamino(null), SIN_CAMINO_FLASH_MS);
  }

  // Interpola posicionVisual (grid units) desde su valor actual hasta
  // `destino` en DURACION_PASO_MS, con ease-out. Nunca se corta a medias:
  // una cancelación solo evita que se programe el paso siguiente.
  function animarPaso(destino: Coord, alTerminar: () => void) {
    const origen = posicionVisualRef.current;
    const inicio = Date.now();
    console.log('[MOV] animarPaso: arranca', { origen, destino, rafIdPrevio: rafIdRef.current });

    function frame() {
      const t = Math.min((Date.now() - inicio) / DURACION_PASO_MS, 1);
      const avance = easeOutCubic(t);
      const actual: Coord = {
        x: origen.x + (destino.x - origen.x) * avance,
        y: origen.y + (destino.y - origen.y) * avance,
      };
      posicionVisualRef.current = actual;
      setPosicionVisual(actual);

      if (t < 1) {
        rafIdRef.current = requestAnimationFrame(frame);
      } else {
        rafIdRef.current = null;
        console.log('[MOV] animarPaso: termina', { destino });
        alTerminar();
      }
    }
    rafIdRef.current = requestAnimationFrame(frame);
  }

  // Se llama al terminar de animar un paso: confirma la posición, revela
  // niebla (radio 3 si el tile de llegada es montaña, si no 1), persiste en
  // Supabase (fire-and-forget) y sigue con el próximo paso de la cola, si
  // quedó alguno tras un posible redirect.
  function completarPaso(destinoPaso: Coord) {
    console.log('[MOV] completarPaso: inicio', {
      destinoPaso,
      bioma: !!bioma,
      colaAntes: [...colaRef.current],
      progresoRefActual: progresoRef.current && {
        posicion_q: progresoRef.current.posicion_q,
        posicion_r: progresoRef.current.posicion_r,
      },
    });
    if (!bioma) {
      console.log('[MOV] completarPaso: ABORTA por !bioma');
      return;
    }
    const tileDestino = tilesPorClave.get(claveCoord(destinoPaso));
    const radio = tileDestino?.tipo === 'montana' ? RADIO_VISION_MONTANA : RADIO_VISION_DEFAULT;

    const actualizadas = fusionarDescubiertas(descubiertasRef.current, destinoPaso, tilesPorClave, radio);
    const huboNuevoDescubrimiento = actualizadas.size !== descubiertasRef.current.size;
    descubiertasRef.current = actualizadas;
    setDescubiertas(actualizadas);

    const progresoAnterior = progresoRef.current;
    if (progresoAnterior) {
      const progresoActualizado = { ...progresoAnterior, posicion_q: destinoPaso.x, posicion_r: destinoPaso.y };
      progresoRef.current = progresoActualizado;
      setProgreso(progresoActualizado);

      supabase
        .from('progreso_jugador')
        .update({ posicion_q: destinoPaso.x, posicion_r: destinoPaso.y })
        .eq('id', progresoActualizado.id)
        .then(({ error: errMover }) => {
          if (errMover) setError(errMover.message);
        });
    }

    if (huboNuevoDescubrimiento && descubrimientoId) {
      supabase
        .from('descubrimiento_jugador')
        .update({ casillas_descubiertas: Array.from(actualizadas.values()) })
        .eq('id', descubrimientoId)
        .then(({ error: errDesc }) => {
          if (errDesc) setError(errDesc.message);
        });
    }

    colaRef.current.shift();
    console.log('[MOV] completarPaso: fin', { colaDespues: [...colaRef.current] });
    if (colaRef.current.length > 0) {
      ejecutarSiguientePaso();
    } else {
      setCaminando(false);
    }
  }

  function ejecutarSiguientePaso() {
    const destino = colaRef.current[0];
    console.log('[MOV] ejecutarSiguientePaso', { destino, cola: [...colaRef.current] });
    if (!destino) {
      console.log('[MOV] ejecutarSiguientePaso: ABORTA, cola vacia');
      return;
    }
    animarPaso(destino, () => completarPaso(destino));
  }

  // Punto de entrada del tap sobre una casilla descubierta: calcula el
  // camino con BFS y lo agenda. Si ya hay un camino en curso, el tap actúa
  // como redirect — el paso que ya está animando (colaRef.current[0]) nunca
  // se interrumpe, el nuevo tramo simplemente continúa desde ahí en cuanto
  // ese paso termine.
  function iniciarCaminoHacia(destino: Coord) {
    console.log('[MOV] iniciarCaminoHacia: tap', {
      destino,
      progreso: progreso && { posicion_q: progreso.posicion_q, posicion_r: progreso.posicion_r },
      colaActual: [...colaRef.current],
      caminando,
    });
    if (!progreso || !bioma) {
      console.log('[MOV] iniciarCaminoHacia: ABORTA por !progreso/!bioma');
      return;
    }
    // Gate de niebla: antes vivía en el onPress condicional del Polygon;
    // ahora que el tap se detecta por geometría (Gesture.Tap), tiene que
    // vivir acá para que cualquier llamador quede protegido igual.
    if (!descubiertas.has(claveCoord(destino))) {
      console.log('[MOV] iniciarCaminoHacia: ABORTA, destino en niebla');
      return;
    }

    const enCaminoActual = colaRef.current.length > 0;
    const origenPlanificacion = enCaminoActual ? colaRef.current[0] : { x: progreso.posicion_q, y: progreso.posicion_r };

    const tramoNuevo = encontrarCamino(origenPlanificacion, destino, tilesPorClave);
    console.log('[MOV] iniciarCaminoHacia: resultado BFS', { origenPlanificacion, destino, enCaminoActual, tramoNuevo });
    if (tramoNuevo === null) {
      console.log('[MOV] iniciarCaminoHacia: sin camino, muestra flash');
      mostrarSinCamino(destino);
      return;
    }

    if (enCaminoActual) {
      colaRef.current = [colaRef.current[0], ...tramoNuevo];
      console.log('[MOV] iniciarCaminoHacia: redirect aplicado', { colaNueva: [...colaRef.current] });
    } else {
      colaRef.current = tramoNuevo;
      if (colaRef.current.length > 0) {
        setCaminando(true);
        console.log('[MOV] iniciarCaminoHacia: arranca camino nuevo', { cola: [...colaRef.current] });
        ejecutarSiguientePaso();
      } else {
        console.log('[MOV] iniciarCaminoHacia: tramo vacio (ya esta ahi), no hace nada');
      }
    }
  }
  // Reasignado en cada render (no useEffect: tiene que estar listo apenas
  // se comitea, no un tick después) para que gestoTap, con su closure
  // congelada desde el montaje, siempre llame a la versión más reciente.
  iniciarCaminoHaciaRef.current = iniciarCaminoHacia;

  function mostrarMensaje(texto: string) {
    setMensajeAccion(texto);
    if (mensajeTimeoutRef.current) clearTimeout(mensajeTimeoutRef.current);
    mensajeTimeoutRef.current = setTimeout(() => setMensajeAccion(null), MENSAJE_ACCION_MS);
  }

  // Casilla donde está parado el jugador ahora mismo (posición ya asentada,
  // no la interpolada) — es donde puede interactuar con cofres/recursos.
  const tileActual = useMemo(() => {
    if (!progreso) return null;
    return tilesPorClave.get(claveCoord({ x: progreso.posicion_q, y: progreso.posicion_r })) ?? null;
  }, [progreso, tilesPorClave]);

  const habilitados = useMemo(
    () => calcularRecursosHabilitados(inventario, catalogoObjetos),
    [inventario, catalogoObjetos]
  );

  const inventarioAgrupado = useMemo(() => {
    const conteo = new Map<string, number>();
    for (const item of inventario) {
      conteo.set(item.objeto_id, (conteo.get(item.objeto_id) ?? 0) + 1);
    }
    return Array.from(conteo.entries())
      .map(([objetoId, cantidad]) => ({ objeto: catalogoObjetos.get(objetoId), cantidad }))
      .filter((it): it is { objeto: Objeto; cantidad: number } => it.objeto !== undefined)
      .sort((a, b) => a.objeto.nombre.localeCompare(b.objeto.nombre));
  }, [inventario, catalogoObjetos]);

  async function abrirCofre() {
    if (!progreso || !descubrimientoId || !tileActual?.cofre) return;
    const clave = claveCoord({ x: progreso.posicion_q, y: progreso.posicion_r });
    if (cofresAbiertos.has(clave)) return;

    const { objetoId, cantidad } = tileActual.cofre;
    const filas = Array.from({ length: cantidad }, () => ({ usuario_id: session.user.id, objeto_id: objetoId }));

    const { data: filasInsertadas, error: errInv } = await supabase
      .from('inventario_jugador')
      .insert(filas)
      .select();
    if (errInv) {
      setError(errInv.message);
      return;
    }

    const nuevosAbiertos = new Map(cofresAbiertos);
    nuevosAbiertos.set(clave, { x: progreso.posicion_q, y: progreso.posicion_r });
    setCofresAbiertos(nuevosAbiertos);
    setInventario((actual) => [...actual, ...(filasInsertadas ?? [])]);

    const objeto = catalogoObjetos.get(objetoId);
    mostrarMensaje(`+${cantidad} ${objeto?.nombre ?? 'objeto'}`);

    const { error: errDesc } = await supabase
      .from('descubrimiento_jugador')
      .update({ cofres_abiertos: Array.from(nuevosAbiertos.values()) })
      .eq('id', descubrimientoId);
    if (errDesc) setError(errDesc.message);
  }

  async function recolectar() {
    if (!progreso || !descubrimientoId || !tileActual?.recurso) return;
    const recurso = tileActual.recurso;
    if (!habilitados.has(recurso)) return;

    const clave = claveCoord({ x: progreso.posicion_q, y: progreso.posicion_r });
    if (recursosRecolectados.has(clave)) return;

    const objeto = objetoParaRecurso(catalogoObjetos, recurso);
    if (!objeto) return;

    const { data, error: errInv } = await supabase
      .from('inventario_jugador')
      .insert({ usuario_id: session.user.id, objeto_id: objeto.id })
      .select()
      .single();
    if (errInv) {
      setError(errInv.message);
      return;
    }

    const nuevos = new Map(recursosRecolectados);
    nuevos.set(clave, { x: progreso.posicion_q, y: progreso.posicion_r });
    setRecursosRecolectados(nuevos);
    setInventario((actual) => [...actual, data]);
    mostrarMensaje(`+1 ${objeto.nombre}`);

    const { error: errDesc } = await supabase
      .from('descubrimiento_jugador')
      .update({ recursos_recolectados: Array.from(nuevos.values()) })
      .eq('id', descubrimientoId);
    if (errDesc) setError(errDesc.message);
  }

  const limitesBioma = useMemo<LimitesBioma | null>(() => {
    if (pixelesBioma.length === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const { pixel } of pixelesBioma) {
      if (pixel.x < minX) minX = pixel.x;
      if (pixel.x > maxX) maxX = pixel.x;
      if (pixel.y < minY) minY = pixel.y;
      if (pixel.y > maxY) maxY = pixel.y;
    }
    return { minX, maxX, minY, maxY };
  }, [pixelesBioma]);

  useEffect(() => {
    limitesRef.current = limitesBioma;
  }, [limitesBioma]);

  const zoomMinimo = useMemo(() => calcularZoomMinimo(limitesBioma), [limitesBioma]);

  useEffect(() => {
    zoomMinRef.current = zoomMinimo;
    setZoom((z) => Math.max(z, zoomMinimo));
  }, [zoomMinimo]);

  function calcularEscala(zoomActual: number): number {
    const { width, height } = tamanoRef.current;
    if (!width || !height) return 1;
    const vbAncho = (SEMI_ANCHO_BASE / zoomActual) * 2;
    const vbAlto = (SEMI_ALTO_BASE / zoomActual) * 2;
    return Math.max(width / vbAncho, height / vbAlto);
  }

  // Inversa de todo lo que arma `geometria.viewBox`: de un punto tocado
  // (relativo al contenedor del mapa) a qué tile del grid corresponde.
  // Necesario porque Gesture.Tap, a diferencia de Polygon.onPress, no sabe
  // sobre qué polígono cayó el toque — solo da el punto en pantalla.
  function tileDesdeToque(localX: number, localY: number): TileBioma | null {
    const { width, height } = tamanoRef.current;
    if (!width || !height) return null;

    const zoomActual = zoomRef.current;
    const escala = calcularEscala(zoomActual);
    const semiAncho = SEMI_ANCHO_BASE / zoomActual;
    const semiAlto = SEMI_ALTO_BASE / zoomActual;

    const centroJugador = isoAPixel(posicionVisualRef.current, ANCHO_TILE, ALTO_TILE);
    const centroX = centroJugador.x + cameraOffsetRef.current.x;
    const centroY = centroJugador.y + cameraOffsetRef.current.y;
    const viewBoxMinX = centroX - semiAncho;
    const viewBoxMinY = centroY - semiAlto;
    const viewBoxAncho = semiAncho * 2;
    const viewBoxAlto = semiAlto * 2;

    // "xMidYMid slice": el contenido se escala de forma uniforme para
    // cubrir el contenedor y se recorta lo que sobra, centrado — hay que
    // deshacer ese offset de centrado antes de pasar a coordenadas de
    // viewBox.
    const offsetX = (width - viewBoxAncho * escala) / 2;
    const offsetY = (height - viewBoxAlto * escala) / 2;

    const svgX = viewBoxMinX + (localX - offsetX) / escala;
    const svgY = viewBoxMinY + (localY - offsetY) / escala;

    const coordGrid = pixelAGrid(svgX, svgY, ANCHO_TILE, ALTO_TILE);
    return tilesPorClaveRef.current.get(claveCoord(coordGrid)) ?? null;
  }

  const gestoTap = useMemo(
    () =>
      Gesture.Tap()
        .maxDistance(20)
        .onStart((e) => {
          const tile = tileDesdeToque(e.x, e.y);
          console.log('[MOV-GESTO] tap reconocido', { x: e.x, y: e.y, tile });
          if (tile) iniciarCaminoHaciaRef.current(tile);
        }),
    []
  );

  const gestoPan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(20)
        .onTouchesDown((e) => {
          console.log('[MOV-GESTO] pan onTouchesDown', { t: Date.now(), toques: e.allTouches.length });
        })
        .onBegin(() => {
          console.log('[MOV-GESTO] pan onBegin (cruzo minDistance, se activa como pan)', { t: Date.now() });
          offsetInicioGesto.current = cameraOffsetRef.current;
        })
        .onUpdate((e) => {
          console.log('[MOV-GESTO] pan onUpdate', {
            t: Date.now(),
            translationX: e.translationX,
            translationY: e.translationY,
          });
          const prog = progresoRef.current;
          if (!prog) return;
          const escala = calcularEscala(zoomRef.current);
          // El clamp usa la posición de grid ya asentada (no la interpolada
          // de posicionVisualRef), para que el límite del pan no se mueva
          // bajo el dedo mientras el personaje camina solo entre casillas.
          const centroJugador = isoAPixel({ x: prog.posicion_q, y: prog.posicion_r }, ANCHO_TILE, ALTO_TILE);
          const propuesto: Coord = {
            x: offsetInicioGesto.current.x - e.translationX / escala,
            y: offsetInicioGesto.current.y - e.translationY / escala,
          };
          setCameraOffset(limitarOffset(propuesto, centroJugador, limitesRef.current));
        })
        .onFinalize((e, success) => {
          console.log('[MOV-GESTO] pan onFinalize', { t: Date.now(), success });
        }),
    []
  );

  const gestoPinch = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          zoomInicioGesto.current = zoomRef.current;
        })
        .onUpdate((e) => {
          const nuevoZoom = Math.min(Math.max(zoomInicioGesto.current * e.scale, zoomMinRef.current), ZOOM_MAX);
          setZoom(nuevoZoom);
        }),
    []
  );

  // Botones de zoom (paso multiplicativo, mismo criterio que el pinch) —
  // solo para web: el trackpad de una notebook/Chromebook no siempre hace
  // bien el gesto de pellizco, a diferencia del táctil real en mobile.
  const PASO_ZOOM = 1.25;
  function acercarZoom() {
    setZoom((z) => Math.min(z * PASO_ZOOM, ZOOM_MAX));
  }
  function alejarZoom() {
    setZoom((z) => Math.max(z / PASO_ZOOM, zoomMinRef.current));
  }

  // Race entre tap y pan: ambos arrancan a evaluar juntos apenas el dedo
  // toca. El pan responde de inmediato en cuanto cruza minDistance(20) (no
  // espera a que el tap "falle" primero, como pasaría con Exclusive). El
  // tap solo se reconoce al soltar, y solo si el movimiento se mantuvo por
  // debajo de maxDistance(20) — mismo umbral que minDistance del pan, sin
  // zona muerta entre los dos. El pinch sigue simultáneo aparte, como
  // antes, para que pan+pinch de dos dedos se sigan sintiendo igual.
  const gestoCompuesto = useMemo(
    () => Gesture.Simultaneous(Gesture.Race(gestoTap, gestoPan), gestoPinch),
    [gestoTap, gestoPan, gestoPinch]
  );

  const geometria = useMemo(() => {
    if (!bioma || !progreso || pixelesBioma.length === 0) return null;

    // Cámara centrada en jugador + offset de pan, con radio ajustado por zoom.
    // La proyección isométrica de un grid cuadrado sale ~2:1 (ancho:alto); usar
    // "slice" en vez de "meet" llena la pantalla recortando laterales en vez de
    // dejar huecos arriba/abajo en un móvil vertical.
    const centroJugador = isoAPixel(posicionVisual, ANCHO_TILE, ALTO_TILE);
    const semiAncho = SEMI_ANCHO_BASE / zoom;
    const semiAlto = SEMI_ALTO_BASE / zoom;
    const centroX = centroJugador.x + cameraOffset.x;
    const centroY = centroJugador.y + cameraOffset.y;
    const viewBox = `${centroX - semiAncho} ${centroY - semiAlto} ${semiAncho * 2} ${semiAlto * 2}`;

    // Culling: con biomas de cientos/miles de tiles, solo mapeamos/ordenamos los
    // que caen dentro (o cerca) de la ventana de cámara actual, no el bioma entero.
    const margenX = ANCHO_TILE;
    const margenY = ALTO_TILE;
    const minXVisible = centroX - semiAncho - margenX;
    const maxXVisible = centroX + semiAncho + margenX;
    const minYVisible = centroY - semiAlto - margenY;
    const maxYVisible = centroY + semiAlto + margenY;

    const puntos = pixelesBioma
      .filter(
        ({ pixel }) =>
          pixel.x >= minXVisible && pixel.x <= maxXVisible && pixel.y >= minYVisible && pixel.y <= maxYVisible
      )
      .sort((a, b) => claveProfundidad(a.tile) - claveProfundidad(b.tile));

    return { puntos, viewBox };
  }, [bioma, progreso, posicionVisual, cameraOffset, zoom, pixelesBioma]);

  if (cargando) {
    return (
      <View style={styles.centrado}>
        <ActivityIndicator size="large" color="#F4B93F" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centrado}>
        <Text style={styles.error}>{error}</Text>
        <TouchableOpacity style={styles.boton} onPress={cargarPartida}>
          <Text style={styles.botonTexto}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!progreso || !bioma || !geometria) return null;

  const claveActual = tileActual ? claveCoord(tileActual) : null;
  const mostrarBotonCofre = !caminando && !!tileActual?.cofre && !!claveActual && !cofresAbiertos.has(claveActual);
  const mostrarBotonRecurso = !caminando && !!tileActual?.recurso && !!claveActual && !recursosRecolectados.has(claveActual);
  const recursoHabilitado = tileActual?.recurso ? habilitados.has(tileActual.recurso) : false;
  const herramientaFaltante =
    tileActual?.recurso && !recursoHabilitado ? herramientaParaRecurso(catalogoObjetos, tileActual.recurso) : undefined;

  // Río revertido a relleno plano — ver comentario en el render del Svg más
  // abajo. Se dejan sin usar (no se borran) como referencia para retomar.
  // const tileRevelado = (t: TileBioma) => DEBUG_SIN_FOG || descubiertas.has(claveCoord(t));
  // const juntasRioVisibles = rioGeometria.juntas.filter((j) => tileRevelado(j.tile));
  // const tramosRioVisibles = rioGeometria.tramos.filter((t) => tileRevelado(t.a.tile) && tileRevelado(t.b.tile));

  return (
    <View style={styles.contenedor}>
      <View style={styles.encabezado}>
        <View>
          <Text style={styles.titulo}>{bioma.nombre}</Text>
          <Text style={styles.subtitulo}>
            Nivel {progreso.nivel} · Fuerza {progreso.fuerza}
          </Text>
        </View>
        <View style={styles.accionesEncabezado}>
          <TouchableOpacity onPress={() => setInventarioVisible(true)}>
            <Text style={styles.enlace}>Inventario ({inventario.length})</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => supabase.auth.signOut()}>
            <Text style={styles.enlace}>Cerrar sesión</Text>
          </TouchableOpacity>
        </View>
      </View>

      {mensajeAccion && (
        <View style={styles.mensajeAccion}>
          <Text style={styles.mensajeAccionTexto}>{mensajeAccion}</Text>
        </View>
      )}

      <Modal visible={inventarioVisible} transparent animationType="fade" onRequestClose={() => setInventarioVisible(false)}>
        <View style={styles.modalFondo}>
          <View style={styles.modalContenido}>
            <Text style={styles.modalTitulo}>Inventario</Text>
            {inventarioAgrupado.length === 0 ? (
              <Text style={styles.modalVacio}>Todavía no tenés objetos.</Text>
            ) : (
              inventarioAgrupado.map(({ objeto, cantidad }) => (
                <View key={objeto.id} style={styles.modalFila}>
                  <Text style={styles.modalObjetoNombre}>{objeto.nombre}</Text>
                  <Text style={styles.modalObjetoCantidad}>x{cantidad}</Text>
                </View>
              ))
            )}
            <TouchableOpacity style={styles.boton} onPress={() => setInventarioVisible(false)}>
              <Text style={styles.botonTexto}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <GestureDetector gesture={gestoCompuesto}>
        <View
          style={styles.mapaContenedor}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setTamanoContenedor({ width, height });
          }}
        >
          <Svg width="100%" height="100%" viewBox={geometria.viewBox} preserveAspectRatio="xMidYMid slice">
            {geometria.puntos.map(({ tile, pixel }) => {
              const clave = claveCoord(tile);
              const descubierta = descubiertas.has(clave);
              const revelada = DEBUG_SIN_FOG || descubierta;
              const sinCamino = casillaSinCamino === clave;
              const puntosPoligono = esquinasRombo(pixel.x, pixel.y, ANCHO_TILE - 3, ALTO_TILE - 3);

              const relleno = revelada ? colorTile(tile.tipo) : '#1B2536';
              // Textura solo en tiles revelados — si se dibujara también en
              // niebla, la silueta (montaña, río) se filtraría a través del
              // fill oscuro de fog, que es una capa aparte con su propio alfa.
              const textura = revelada ? texturaParaTile(tile, tilesPorClave, recursosRecolectados.has(clave)) : null;

              return (
                <Fragment key={clave}>
                  <Polygon
                    points={puntosPoligono}
                    fill={relleno}
                    stroke={sinCamino ? '#E8746A' : '#2C394D'}
                    strokeWidth={sinCamino ? 2.5 : 1}
                  />
                  {textura && (
                    <G transform={`translate(${pixel.x},${pixel.y}) ${textura.transform ?? ''}`}>
                      <ImagenSvg
                        href={textura.fuente}
                        x={-ANCHO_TILE / 2}
                        y={textura.centrado ? -textura.alto / 2 : -ALTO_TILE / 2}
                        width={ANCHO_TILE}
                        height={textura.alto}
                        preserveAspectRatio="xMidYMid meet"
                      />
                    </G>
                  )}
                </Fragment>
              );
            })}

            {/*
              Río revertido a relleno plano (colorTile) mientras se prepara
              arte direccional nuevo — la cinta calculada (juntas + tramos,
              con borde oscuro + agua encima) no se veía bien. Se deja
              comentada, sin borrar, como referencia para retomarla:

              {juntasRioVisibles.map((j) => (
                <Circle
                  key={`rio-borde-j-${claveCoord(j.tile)}`}
                  cx={j.pixel.x}
                  cy={j.pixel.y}
                  r={(j.ancho + RIO_BORDE_EXTRA) / 2}
                  fill={COLOR_RIO_BORDE}
                />
              ))}
              {tramosRioVisibles.map((t) => (
                <Polygon
                  key={`rio-borde-t-${[claveCoord(t.a.tile), claveCoord(t.b.tile)].sort().join('_')}`}
                  points={franjaAgua(t.a.pixel, t.b.pixel, t.ancho + RIO_BORDE_EXTRA)}
                  fill={COLOR_RIO_BORDE}
                />
              ))}
              {juntasRioVisibles.map((j) => (
                <Circle
                  key={`rio-agua-j-${claveCoord(j.tile)}`}
                  cx={j.pixel.x}
                  cy={j.pixel.y}
                  r={j.ancho / 2}
                  fill={COLOR_RIO_AGUA}
                />
              ))}
              {tramosRioVisibles.map((t) => (
                <Polygon
                  key={`rio-agua-t-${[claveCoord(t.a.tile), claveCoord(t.b.tile)].sort().join('_')}`}
                  points={franjaAgua(t.a.pixel, t.b.pixel, t.ancho)}
                  fill={COLOR_RIO_AGUA}
                />
              ))}
            */}

            {geometria.puntos
              .filter(
                ({ tile }) =>
                  descubiertas.has(claveCoord(tile)) &&
                  tile.recurso &&
                  !recursosRecolectados.has(claveCoord(tile)) &&
                  // 'arbol' ya tiene su propia textura de tile (dead-tree.png)
                  // que deja claro qué es — el ícono encima sería redundante.
                  // Los tiles de madera "sueltos" (tipo 'arena', de prueba)
                  // sí lo necesitan, como piedra/lana.
                  tile.tipo !== 'arbol'
              )
              .map(({ tile, pixel }) => {
                const icono = ICONOS_RECURSO[tile.recurso!] ?? ICONOS_RECURSO.madera;
                return (
                  <IconoMapa
                    key={`recurso-${claveCoord(tile)}`}
                    segmentos={icono.segmentos}
                    x={pixel.x}
                    y={pixel.y}
                    color={icono.color}
                  />
                );
              })}

            {geometria.puntos
              .filter(
                ({ tile }) => descubiertas.has(claveCoord(tile)) && tile.cofre && !cofresAbiertos.has(claveCoord(tile))
              )
              .map(({ tile, pixel }) => (
                <IconoMapa
                  key={`cofre-${claveCoord(tile)}`}
                  segmentos={ICONO_COFRE}
                  x={pixel.x}
                  y={pixel.y}
                  color="#D4A017"
                />
              ))}

            {(() => {
              const pixelJugador = isoAPixel(posicionVisual, ANCHO_TILE, ALTO_TILE);
              return (
                <ImagenSvg
                  href={SPRITE_JUGADOR}
                  x={pixelJugador.x - SPRITE_ANCHO / 2}
                  y={pixelJugador.y - SPRITE_ALTO}
                  width={SPRITE_ANCHO}
                  height={SPRITE_ALTO}
                  preserveAspectRatio="xMidYMid meet"
                />
              );
            })()}
          </Svg>

          <TouchableOpacity style={styles.botonCentrar} onPress={() => setCameraOffset({ x: 0, y: 0 })}>
            <Text style={styles.botonCentrarTexto}>Centrar</Text>
          </TouchableOpacity>

          {Platform.OS === 'web' && (
            <View style={styles.controlesZoom}>
              <TouchableOpacity style={styles.botonZoom} onPress={acercarZoom}>
                <Text style={styles.botonZoomTexto}>+</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.botonZoom} onPress={alejarZoom}>
                <Text style={styles.botonZoomTexto}>−</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </GestureDetector>

      {(mostrarBotonCofre || mostrarBotonRecurso) && (
        <View style={styles.accionesTile}>
          {mostrarBotonCofre && (
            <TouchableOpacity style={styles.boton} onPress={abrirCofre}>
              <Text style={styles.botonTexto}>Abrir cofre</Text>
            </TouchableOpacity>
          )}
          {mostrarBotonRecurso && (
            <View>
              <TouchableOpacity
                style={[styles.boton, !recursoHabilitado && styles.botonDeshabilitado]}
                onPress={recolectar}
                disabled={!recursoHabilitado}
              >
                <Text style={styles.botonTexto}>Recolectar</Text>
              </TouchableOpacity>
              {!recursoHabilitado && (
                <Text style={styles.textoFaltaHerramienta}>
                  Necesitás: {herramientaFaltante?.nombre ?? 'una herramienta'}
                </Text>
              )}
            </View>
          )}
        </View>
      )}

      <Text style={styles.ayuda}>Toca una casilla ya descubierta para caminar hasta ahí. Arrastra para mirar el mapa.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  contenedor: {
    flex: 1,
    backgroundColor: '#141B26',
    paddingTop: 56,
    paddingHorizontal: 20,
  },
  centrado: {
    flex: 1,
    backgroundColor: '#141B26',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  encabezado: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  accionesEncabezado: {
    alignItems: 'flex-end',
    gap: 6,
  },
  titulo: {
    fontSize: 24,
    fontWeight: '800',
    color: '#F6EFD8',
  },
  subtitulo: {
    fontSize: 13,
    color: '#7E8BA3',
    marginTop: 2,
  },
  mapaContenedor: {
    flex: 1,
  },
  botonCentrar: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    backgroundColor: '#1B2536',
    borderColor: '#F4B93F',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  botonCentrarTexto: {
    color: '#F4B93F',
    fontWeight: '700',
    fontSize: 13,
  },
  controlesZoom: {
    position: 'absolute',
    right: 12,
    bottom: 56,
    gap: 8,
  },
  botonZoom: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1B2536',
    borderColor: '#F4B93F',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  botonZoomTexto: {
    color: '#F4B93F',
    fontWeight: '700',
    fontSize: 20,
    lineHeight: 22,
  },
  ayuda: {
    fontSize: 12,
    color: '#7E8BA3',
    textAlign: 'center',
    marginVertical: 12,
  },
  enlace: {
    color: '#7BC96F',
    fontSize: 13,
  },
  boton: {
    backgroundColor: '#F4B93F',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  botonTexto: {
    color: '#1D2A38',
    fontWeight: '700',
    fontSize: 15,
  },
  botonDeshabilitado: {
    backgroundColor: '#4A4232',
    opacity: 0.6,
  },
  error: {
    color: '#E8746A',
    textAlign: 'center',
    fontSize: 14,
  },
  mensajeAccion: {
    backgroundColor: '#1B2536',
    borderColor: '#7BC96F',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginBottom: 8,
    alignSelf: 'center',
  },
  mensajeAccionTexto: {
    color: '#7BC96F',
    fontWeight: '700',
    fontSize: 13,
  },
  accionesTile: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginTop: 8,
  },
  textoFaltaHerramienta: {
    color: '#E8746A',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
  },
  modalFondo: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContenido: {
    backgroundColor: '#1B2536',
    borderRadius: 16,
    padding: 20,
    minWidth: 260,
    maxWidth: '85%',
  },
  modalTitulo: {
    color: '#F6EFD8',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 12,
  },
  modalVacio: {
    color: '#7E8BA3',
    fontSize: 13,
    marginBottom: 12,
  },
  modalFila: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomColor: '#2C394D',
    borderBottomWidth: 1,
  },
  modalObjetoNombre: {
    color: '#F6EFD8',
    fontSize: 14,
  },
  modalObjetoCantidad: {
    color: '#F4B93F',
    fontWeight: '700',
    fontSize: 14,
  },
});
