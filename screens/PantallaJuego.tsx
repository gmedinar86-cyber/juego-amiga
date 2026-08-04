import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, G, Image as ImagenSvg, Path, Polygon, Polyline } from 'react-native-svg';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import {
  claveCoord,
  claveProfundidad,
  coordsIguales,
  esquinasRombo,
  isoAPixel,
  pixelAGrid,
  vecinos,
  type Coord,
} from '../lib/isoGrid';
import { esTransitable } from '../lib/generadorTerreno';
import { encontrarCamino, tilesAlcanzables } from '../lib/pathfinding';
import {
  cantidadDeObjeto,
  hayEspacioPara,
  herramientaParaRecurso,
  HERRAMIENTAS_CON_DURABILIDAD,
  objetoParaRecurso,
  RECETAS_CRAFTEO,
  recursosHabilitados as calcularRecursosHabilitados,
  tieneBancoDeTrabajo as calcularTieneBancoDeTrabajo,
  topeInventario,
  USOS_INICIALES_HERRAMIENTA,
} from '../lib/objetos';
import type { Bioma, CuerdaConstruida, DescubrimientoJugador, InventarioItem, Objeto, ProgresoJugador, TileBioma } from '../lib/tipos';

const RADIO_VISION_DEFAULT = 1;
const RADIO_VISION_MONTANA = 3;
const DURACION_PASO_MS = 200;
const SIN_CAMINO_FLASH_MS = 350;
const MENSAJE_ACCION_MS = 1800;
const GOLPE_CACTUS_MS = 400;
const DANO_CACTUS = 2;
const MUERTE_MS = 3000;
const COSTO_PUENTE_MADERA = 10;
// Tope de vida del sistema nuevo de cactus/daño — independiente de
// progreso.vida_maxima (columna preexistente, ya en uso con otro valor
// por defecto para otros fines, no la pisamos).
const VIDA_MAXIMA = 10;
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
const SPRITE_ALTO = ALTO_TILE * 1.1;
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
  // Ancho ya resuelto en px — por defecto ANCHO_TILE (así calzan las caras
  // superiores entre tiles vecinos). Solo se pisa cuando el PNG no comparte
  // proporciones con el resto de su set (ver TEXTURA_RIO_FIN) y hace falta
  // escalarlo distinto para que el contenido real quede del mismo tamaño.
  ancho?: number;
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

// Texturas más altas que TEXTURA_ARENA (montaña, árbol, cactus, oasis) son
// el mismo bloque de arena de base con algo dibujado ENCIMA (ver los PNG:
// la base del bloque queda idéntica, la decoración crece hacia arriba). El
// anclaje por borde superior de arriba asume que todas miden lo mismo que
// TEXTURA_ARENA, así que sin corrección la altura de más se agrega hacia
// ABAJO en vez de hacia arriba — el bloque completo se ve hundido en vez de
// que la decoración sobresalga. Se corrige desplazando la imagen hacia
// arriba exactamente esa diferencia, para que la base quede alineada con
// las casillas vecinas y solo la decoración sobresalga.
function conAlturaExtra(base: Textura): Textura {
  const extra = base.alto - TEXTURA_ARENA.alto;
  if (extra <= 0) return base;
  return { ...base, transform: `translate(0,${-extra})` };
}

// river.png (el tile de río plano original) queda sin usar — reemplazado
// por el sistema de autotiling de abajo. El archivo se deja en el repo por
// si sirve para otra cosa más adelante.
const TEXTURA_OASIS = conAlturaExtra(crearTextura(require('../assets/tiles/oasis.png'), 263, 243));
// mountain-v2.png reemplaza al mountain.png viejo (mismo estilo "roca suelta"
// que roca-cambio-rol/cactus-v2/las variantes con cuerda — sin base de arena
// compartida), así que va con conBaseEnVertice, no conAlturaExtra.
const TEXTURA_MONTANA = conBaseEnVertice(crearTextura(require('../assets/entorno/mountain-v2.png'), 597, 549));
const TEXTURA_ARBOL_SECO = conAlturaExtra(crearTextura(require('../assets/tiles/dead-tree.png'), 263, 278));
// cactus.png: OJO, hay que pasarle las dimensiones REALES del archivo acá
// (263x312) — el ancho/alto que ve <Image preserveAspectRatio="xMidYMid
// meet"> depende de las dimensiones intrínsecas reales del PNG, no de lo
// que le digamos a crearTextura, así que "mentirle" con un alto más chico
// para intentar compensar el margen de más (ver abajo) termina angostando
// la imagen (letterbox) en vez de arreglar nada.
//
// A diferencia de sand/mountain/dead-tree (margen transparente de ~10-11px
// arriba Y abajo), cactus.png tiene 73px de margen transparente abajo —
// un recorte de export distinto al resto, no contenido real. Si se lo
// trata como a los demás (conAlturaExtra), ese margen de más (73-11=62px
// crudos) se suma al desplazamiento hacia arriba y el bloque queda
// flotando. Se descuenta ese margen de más, ya escalado, del extra antes
// de aplicar el mismo criterio que las demás texturas.
// Helper genérico para el mismo problema que cactus.png: un PNG con margen
// transparente de más en un solo borde (recorte de export distinto al
// resto del set), que haría que conAlturaExtra sobrestime el desplazamiento
// y la textura quede flotando. Se le resta el margen de más (ya escalado)
// al extra antes de aplicar el mismo criterio que las demás.
function conMargenAbajoCorregido(base: Textura, anchoOriginal: number, margenAbajoDeMasCrudo: number): Textura {
  const escala = ANCHO_TILE / anchoOriginal;
  const extra = base.alto - TEXTURA_ARENA.alto - margenAbajoDeMasCrudo * escala;
  return extra > 0 ? { ...base, transform: `translate(0,${-extra})` } : base;
}

const TEXTURA_CACTUS = conMargenAbajoCorregido(
  crearTextura(require('../assets/tiles/cactus.png'), 263, 312),
  263,
  73 - 11
);

// roca-cambio-rol.png es en realidad la textura del PORTAL (monolito de
// piedra) — no de la roca de cambio de rol, que todavía no tiene arte
// propia (ver 'roca_clase' en texturaParaTile). A diferencia de las
// texturas de arriba, esta ilustración no dibuja una base de arena para
// calzar contra TEXTURA_ARENA (es una roca "suelta" con su propio pedregal
// en la base, sin la caja de paredes que sí tienen sand/mountain/dead-tree).
// Se ancla distinto: directamente por el vértice INFERIOR del rombo (el
// pedregal apoya ahí), no por el superior — conAlturaExtra asume una base
// compartida que esta pieza no tiene.
function conBaseEnVertice(base: Textura): Textura {
  const extra = base.alto - ALTO_TILE;
  return { ...base, transform: `translate(0,${-extra})` };
}
const TEXTURA_PORTAL = conBaseEnVertice(crearTextura(require('../assets/entorno/roca-cambio-rol.png'), 1209, 1481));

// Igual que conBaseEnVertice, pero para PNGs de este mismo estilo "suelto"
// que además traen un margen transparente real por debajo del contenido
// visible (recorte de export, no contenido) — sin corregirlo, ese margen
// queda POR DEBAJO del vértice del rombo (que es donde ancla conBaseEnVertice)
// y la base visible del dibujo se ve flotando sobre el tile en vez de
// apoyada en él. Mismo criterio que conMargenAbajoCorregido, adaptado al
// anclaje por vértice inferior en vez de por borde superior.
function conBaseEnVerticeConMargen(base: Textura, anchoOriginal: number, margenAbajoCrudo: number): Textura {
  const escala = ANCHO_TILE / anchoOriginal;
  const extra = base.alto - ALTO_TILE - margenAbajoCrudo * escala;
  return { ...base, transform: `translate(0,${-extra})` };
}

// Cactus "peligroso": tile propio (no la variante decorativa de adorno sobre
// montaña, ver TEXTURA_CACTUS/texturaMontana más arriba). Mismo estilo que
// la roca de cambio de rol: dibujo "suelto" con su propia base de arena
// incluida, se ancla por el vértice inferior — cactus-v2.png además tiene
// ~19px de margen transparente real por debajo de esa base (recorte de
// export), que hay que descontar para que quede apoyada en el tile y no
// flotando sobre él.
const TEXTURA_CACTUS_PELIGROSO = conBaseEnVerticeConMargen(
  crearTextura(require('../assets/entorno/cactus-v2.png'), 453, 732),
  453,
  19
);

// Recursos con arte real (reemplazan los íconos placeholder de piedra/lana
// y el cofre): mismo estilo de bloque sobre base de arena que sand/mountain,
// así que van con conAlturaExtra como esas.
const TEXTURA_ROCA_MINERAL = conAlturaExtra(crearTextura(require('../assets/entorno/mining-rock.png'), 249, 232));
const TEXTURA_COFRE_CAJA = conAlturaExtra(crearTextura(require('../assets/entorno/chest.png'), 248, 231));
// sheep.png tiene el mismo problema de margen que cactus.png (43px abajo
// contra ~12px en los otros 3 bordes) — mismo fix.
const TEXTURA_OVEJA = conMargenAbajoCorregido(
  crearTextura(require('../assets/entorno/sheep.png'), 250, 261),
  250,
  43 - 12
);

// Punto "montaña" de una cuerda ya colocada: mismo modelo de roca que
// TEXTURA_MONTANA pero con la soga tallada, para que se note a simple vista
// dónde se puede subir/bajar sin agregar un ícono aparte.
const TEXTURA_MONTANA_CUERDA_1 = conBaseEnVertice(
  crearTextura(require('../assets/entorno/mountain-rope-1.png'), 347, 340)
);
const TEXTURA_MONTANA_CUERDA_2 = conBaseEnVertice(
  crearTextura(require('../assets/entorno/mountain-rope-2.png'), 341, 326)
);

const TEXTURA_PUENTE = conAlturaExtra(crearTextura(require('../assets/entorno/puente-madera.png'), 600, 466));

// Mapa fijo diseñado a mano: todas las 'montana' usan la misma textura, sin
// variedad aleatoria (la mezcla con dead-tree/cactus era del generador
// procedural viejo, no aplica acá). Si el tile tiene una cuerda colocada, eso
// sí pisa la textura: se elige la variante según el LADO real por el que sale
// la cuerda (hacia dónde queda el punto "suelo" respecto a esta montaña en
// pantalla) — rope-1 sale por la izquierda, rope-2 por la derecha.
function texturaMontana(tile: TileBioma, cuerda?: CuerdaConstruida): Textura {
  if (cuerda) {
    const haciaLaDerecha = cuerda.suelo.x - tile.x - (cuerda.suelo.y - tile.y) > 0;
    return haciaLaDerecha ? TEXTURA_MONTANA_CUERDA_2 : TEXTURA_MONTANA_CUERDA_1;
  }
  return TEXTURA_MONTANA;
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

// fin.png no comparte el canvas de sus hermanas (226px de ancho real) — mide
// 238px de ancho. El contenido dibujado (el pool de agua en sí) ocupa el
// mismo tamaño en píxeles crudos que en recto/esquina/ancho/confluencia
// (~210x151, verificado recortando por canal alfa), solo que centrado en un
// canvas más grande. crearTextura fuerza el ancho renderizado a ANCHO_TILE
// SIEMPRE, así que tratar a fin.png igual que a sus hermanas la escala con
// un factor distinto (72/238 en vez de 72/226) y el agua sale más chica y
// desalineada respecto a las piezas vecinas con las que tiene que calzar.
// Se usa acá la MISMA escala que las hermanas (basada en su ancho real,
// 226) en vez de forzar ANCHO_TILE, para que el contenido quede del mismo
// tamaño en pantalla — el ancho final renderizado da ~75px, no 72, y es
// intencional.
const ESCALA_RIO = ANCHO_TILE / 226;
const TEXTURA_RIO_FIN: Textura = {
  fuente: require('../assets/tiles/fin.png'),
  ancho: 238 * ESCALA_RIO,
  alto: 206 * ESCALA_RIO,
};

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
  if (escalaX === 1 && escalaY === 1) return { fuente: base.fuente, alto: base.alto, ancho: base.ancho };
  const centroY = -ALTO_TILE / 2 + base.alto / 2;
  return {
    fuente: base.fuente,
    alto: base.alto,
    ancho: base.ancho,
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
  recolectado: boolean,
  cofreAbierto: boolean,
  cuerdaEnEsteMontana?: CuerdaConstruida
): Textura | null {
  switch (tile.tipo) {
    case 'arena':
      // Cofre / piedra / lana / madera ya tienen su propio bloque con arte
      // real — reemplaza el rombo de arena entero, no es un ícono encima
      // (igual que 'arbol'). Una vez recolectado/abierto vuelve a verse
      // como arena plana.
      if (tile.cofre && !cofreAbierto) return TEXTURA_COFRE_CAJA;
      if (tile.recurso === 'piedra' && !recolectado) return TEXTURA_ROCA_MINERAL;
      if (tile.recurso === 'lana' && !recolectado) return TEXTURA_OVEJA;
      if (tile.recurso === 'madera' && !recolectado) return TEXTURA_ARBOL_SECO;
      return TEXTURA_ARENA;
    case 'rio':
      return texturaRio(tile, tilesPorClave);
    case 'oasis':
      return TEXTURA_OASIS;
    case 'montana':
      return texturaMontana(tile, cuerdaEnEsteMontana);
    case 'arbol':
      // Ya recolectado (madera): vuelve a verse como arena plana, igual que
      // piedra/lana cuando se juntan (ver el filtro de íconos más abajo).
      return recolectado ? TEXTURA_ARENA : TEXTURA_ARBOL_SECO;
    case 'roca_clase':
      // Landmark de cambio de rol, separado del portal — todavía sin arte
      // propia (ver comentario en TEXTURA_PORTAL), sigue con colorTile.
      return null;
    case 'portal':
      return TEXTURA_PORTAL;
    case 'cactus':
      return TEXTURA_CACTUS;
    default:
      return null; // otros tipos sin textura: sigue con colorTile
  }
}

// --- Río como cauce continuo calculado por código (ver plan) ---
const ANCHO_RIO_BASE = ALTO_TILE * 0.6;
const ANCHO_RIO_ANCHO = ANCHO_RIO_BASE * 1.6;
const RIO_BORDE_EXTRA = 6;
const COLOR_RIO_AGUA = '#2E6F8E'; // mismo azul que ya usaba colorTile('rio')
const COLOR_RIO_BORDE = '#1B4E63';
// Color de fondo bajo TEXTURA_PUENTE (asset real, ver más abajo) para que no
// se filtre el azul de río en los márgenes transparentes del PNG.
const COLOR_PUENTE = '#B8894F';

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

// Qué ícono/color usar para cada tipo de recurso de tile sin bloque propio
// — piedra/lana ya tienen textura real (ver texturaParaTile), así que no
// están acá. Agregar un nuevo recurso sin arte (data-driven, ver
// lib/objetos.ts) solo necesita una entrada acá.
const ICONOS_RECURSO: Record<string, { segmentos: SegmentoIcono[]; color: string }> = {
  madera: { segmentos: ICONO_ARBOL, color: '#7BC96F' },
};

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
const DEBUG_SIN_FOG = false;

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
    case 'oasis':
      return '#2E7D6B';
    // 'enemigo'/'jefe_final': todavía sin implementar (ver plan) — solo se
    // guarda la ubicación marcada en el mapa, con un color placeholder para
    // poder verificarla a simple vista hasta que exista la mecánica real.
    case 'enemigo':
      return '#FCA5A5';
    case 'jefe_final':
      return '#7F1D1D';
    // roca_clase todavía no tiene arte propia (ver texturaParaTile) — color
    // plano distintivo (violeta) para que se distinga de la arena mientras
    // tanto. La interacción real de cambio de clase se construye aparte.
    case 'roca_clase':
      return '#8B5CF6';
    default:
      // 'portal' cae acá a propósito: tiene textura propia (el monolito, ver
      // texturaParaTile) que no cubre todo el rombo (es una roca "suelta",
      // no un bloque como sand/montaña) — el fondo visible alrededor debe
      // ser arena, no un color de relleno.
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

// Transitabilidad "de jugador": la genérica de generadorTerreno.ts (nunca
// cuenta montaña/río) más los ríos donde este jugador ya construyó un
// puente. Se arma como factory (no lee estado directo) para poder usarla
// tanto con el Map ya en useState como con uno recién leído de Supabase
// durante la carga inicial, antes de que el estado exista.
function crearEsTransitableJugador(puentes: Map<string, Coord>) {
  return (tile: TileBioma): boolean => esTransitable(tile) || (tile.tipo === 'rio' && puentes.has(claveCoord(tile)));
}

// Vecino CARDINAL (no diagonal) de `origen` que sea río y todavía no tenga
// puente, sin importar el ancho — usado solo para decidir si mostrar el
// botón "Construir puente" (si no hay NINGÚN río cerca, no tiene sentido
// mostrarlo) y para poder distinguir, al explicar por qué falló, entre "no
// hay río cerca" y "hay río pero es muy ancho".
function buscarVecinoRioSinPuente(
  origen: Coord,
  tilesPorClave: Map<string, TileBioma>,
  puentes: Map<string, Coord>
): TileBioma | undefined {
  for (const d of Object.values(BORDE_DELTA)) {
    const vecino = tilesPorClave.get(claveCoord({ x: origen.x + d.x, y: origen.y + d.y }));
    if (vecino?.tipo === 'rio' && !puentes.has(claveCoord(vecino))) return vecino;
  }
  return undefined;
}

// Un tramo de río se considera "de 1 sola casilla de ancho" con el mismo
// criterio que ya usa el render para decidir el ancho visual del río (ver
// rioGeometria/anchoLocal más abajo): más de 2 vecinos (8 direcciones) que
// también son río implica una confluencia o dos filas paralelas, no un
// canal angosto — ahí no se puede construir puente.
function esRioDeUnaCasilla(tile: TileBioma, tilesPorClave: Map<string, TileBioma>): boolean {
  const vecinosRio = vecinos(tile).filter((v) => tilesPorClave.get(claveCoord(v))?.tipo === 'rio').length;
  return vecinosRio <= 2;
}

// Igual que buscarVecinoRioSinPuente, pero solo devuelve un candidato válido
// para construir puente ahí (además angosto). Se usa al construir de verdad.
function buscarVecinoRioParaPuente(
  origen: Coord,
  tilesPorClave: Map<string, TileBioma>,
  puentes: Map<string, Coord>
): TileBioma | undefined {
  for (const d of Object.values(BORDE_DELTA)) {
    const vecino = tilesPorClave.get(claveCoord({ x: origen.x + d.x, y: origen.y + d.y }));
    if (vecino?.tipo === 'rio' && !puentes.has(claveCoord(vecino)) && esRioDeUnaCasilla(vecino, tilesPorClave)) {
      return vecino;
    }
  }
  return undefined;
}

// El lado "suelo" de una cuerda colocada desde una montaña tiene que ser
// arena vacía de verdad (sin recurso ni cofre encima) — no cualquier tile
// que no sea montaña (eso incluiría río, cactus, u otras casillas donde no
// tiene sentido bajar).
function esArenaVaciaParaCuerda(tile: TileBioma): boolean {
  return tile.tipo === 'arena' && !tile.recurso && !tile.cofre;
}

// Para "Colocar cuerda": si el jugador está sobre una montaña, busca un
// vecino de arena vacía (el lado "suelo" al que se baja); si está en
// tierra, busca un vecino que SÍ sea montaña (el lado "montaña" al que se
// sube). "Al lado" usa las 8 direcciones (vecinos), no solo cardinales — una
// montaña es un área, no una arista fina como el río.
function buscarParParaCuerda(
  origen: TileBioma,
  tilesPorClave: Map<string, TileBioma>
): CuerdaConstruida | undefined {
  if (origen.tipo === 'montana') {
    for (const v of vecinos(origen)) {
      const vecino = tilesPorClave.get(claveCoord(v));
      if (vecino && esArenaVaciaParaCuerda(vecino)) return { suelo: vecino, montana: origen };
    }
    return undefined;
  }
  for (const v of vecinos(origen)) {
    const vecino = tilesPorClave.get(claveCoord(v));
    if (vecino?.tipo === 'montana') return { suelo: origen, montana: vecino };
  }
  return undefined;
}

function buscarCuerdaPorSuelo(cuerdas: CuerdaConstruida[], coord: Coord): CuerdaConstruida | undefined {
  return cuerdas.find((c) => coordsIguales(c.suelo, coord));
}

function buscarCuerdaPorMontana(cuerdas: CuerdaConstruida[], coord: Coord): CuerdaConstruida | undefined {
  return cuerdas.find((c) => coordsIguales(c.montana, coord));
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
  const [puentesConstruidos, setPuentesConstruidos] = useState<Map<string, Coord>>(new Map());
  const [cuerdasConstruidas, setCuerdasConstruidas] = useState<CuerdaConstruida[]>([]);
  const [inventarioVisible, setInventarioVisible] = useState(false);
  const [crafteoVisible, setCrafteoVisible] = useState(false);
  const [resetVisible, setResetVisible] = useState(false);
  const [ayudaVisible, setAyudaVisible] = useState(false);
  const [mensajeAccion, setMensajeAccion] = useState<string | null>(null);
  const [golpeCactus, setGolpeCactus] = useState(false);
  const [muriendoVisible, setMuriendoVisible] = useState(false);
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
  const golpeCactusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const muerteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (golpeCactusTimeoutRef.current) clearTimeout(golpeCactusTimeoutRef.current);
      if (muerteTimeoutRef.current) clearTimeout(muerteTimeoutRef.current);
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
    radio: number = RADIO_VISION_DEFAULT,
    esTransitableFn: (tile: TileBioma) => boolean = crearEsTransitableJugador(puentesConstruidos)
  ): Map<string, Coord> {
    const resultado = new Map(actuales);
    for (const c of tilesAlcanzables(centro, radio, tilesPorClaveBioma, esTransitableFn)) {
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

      const esJugadorNuevo = !progresoData;
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
      const puentesTempranos = new Map<string, Coord>(
        (descData?.puentes_construidos ?? []).map((c) => [claveCoord(c), c])
      );
      const reveladas = fusionarDescubiertas(
        previas,
        posicionActual,
        tilesPorClaveInicial,
        RADIO_VISION_DEFAULT,
        crearEsTransitableJugador(puentesTempranos)
      );

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
      const puentesIniciales = new Map<string, Coord>(
        (descFinal.puentes_construidos ?? []).map((c) => [claveCoord(c), c])
      );
      const cuerdasIniciales = descFinal.cuerdas_construidas ?? [];

      const { data: objetosData, error: errObjetos } = await supabase.from('objetos').select('*');
      if (errObjetos) throw errObjetos;
      const catalogo = new Map<string, Objeto>((objetosData ?? []).map((o) => [o.id, o as Objeto]));

      const { data: inventarioData, error: errInventario } = await supabase
        .from('inventario_jugador')
        .select('*')
        .eq('usuario_id', session.user.id);
      if (errInventario) throw errInventario;

      // Todo jugador nuevo arranca con un Hacha en el inventario.
      let inventarioFinal = inventarioData ?? [];
      if (esJugadorNuevo) {
        const hacha = Array.from(catalogo.values()).find((o) => o.nombre === 'Hacha');
        if (hacha) {
          const { data: hachaInicial, error: errHacha } = await supabase
            .from('inventario_jugador')
            .insert({ usuario_id: session.user.id, objeto_id: hacha.id, usos_restantes: USOS_INICIALES_HERRAMIENTA })
            .select()
            .single();
          if (errHacha) throw errHacha;
          inventarioFinal = [...inventarioFinal, hachaInicial];
        }
      }

      const posicionInicial: Coord = { x: progresoData.posicion_q, y: progresoData.posicion_r };
      posicionVisualRef.current = posicionInicial;
      descubiertasRef.current = reveladas;

      setProgreso(progresoData);
      setBioma(biomaData);
      setDescubiertas(reveladas);
      setPosicionVisual(posicionInicial);
      setCofresAbiertos(cofresIniciales);
      setRecursosRecolectados(recursosIniciales);
      setPuentesConstruidos(puentesIniciales);
      setCuerdasConstruidas(cuerdasIniciales);
      setCatalogoObjetos(catalogo);
      setInventario(inventarioFinal);
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
    if (!bioma) return;
    const tileDestino = tilesPorClave.get(claveCoord(destinoPaso));

    if (tileDestino?.tipo === 'cactus') {
      const casillaAnterior = progresoRef.current
        ? { x: progresoRef.current.posicion_q, y: progresoRef.current.posicion_r }
        : destinoPaso;
      golpearCactus(casillaAnterior);
      return;
    }

    const enMontana = tileDestino?.tipo === 'montana';
    const radio = enMontana ? RADIO_VISION_MONTANA : RADIO_VISION_DEFAULT;
    // El predicado por defecto de fusionarDescubiertas (transitabilidad de
    // suelo) excluye 'montana' — si se usara acá, el BFS de revelado ni
    // siquiera podría expandirse desde el propio tile donde está parado el
    // jugador (radio 3 quedaría en los hechos como radio 0). Parado en una
    // montaña, el radio se expande a través del cúmulo de montaña conectado,
    // igual que ya restringe el movimiento por tap (ver iniciarCaminoHacia).
    const predicadoVision = enMontana ? (t: TileBioma) => t.tipo === 'montana' : undefined;

    const actualizadas = fusionarDescubiertas(
      descubiertasRef.current,
      destinoPaso,
      tilesPorClave,
      radio,
      predicadoVision
    );
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
    if (colaRef.current.length > 0) {
      ejecutarSiguientePaso();
    } else {
      setCaminando(false);
    }
  }

  // Tocar un cactus resta vida y hace retroceder al jugador a la casilla
  // anterior en vez de asentarlo ahí — corta cualquier paso encolado (no
  // tiene sentido seguir un camino que pasaba por el cactus) y rebota la
  // animación de vuelta.
  function golpearCactus(casillaAnterior: Coord) {
    colaRef.current = [];
    setGolpeCactus(true);
    if (golpeCactusTimeoutRef.current) clearTimeout(golpeCactusTimeoutRef.current);
    golpeCactusTimeoutRef.current = setTimeout(() => setGolpeCactus(false), GOLPE_CACTUS_MS);
    mostrarMensaje(`-${DANO_CACTUS} vida (cactus)`);

    const progresoActual = progresoRef.current;
    let vidaLlegoACero = false;
    if (progresoActual) {
      const vidaNueva = Math.max(0, progresoActual.vida_actual - DANO_CACTUS);
      vidaLlegoACero = vidaNueva === 0;
      const progresoActualizado = { ...progresoActual, vida_actual: vidaNueva };
      progresoRef.current = progresoActualizado;
      setProgreso(progresoActualizado);
      supabase
        .from('progreso_jugador')
        .update({ vida_actual: vidaNueva })
        .eq('id', progresoActualizado.id)
        .then(({ error: errVida }) => {
          if (errVida) setError(errVida.message);
        });
    }

    // Vida a 0: mensaje de "HAS MUERTO..." en el centro de la pantalla
    // durante MUERTE_MS, y después el mismo reset completo que el botón
    // "Reiniciar nivel" (posición, inventario, descubrimiento, etc.).
    if (vidaLlegoACero) {
      setMuriendoVisible(true);
      if (muerteTimeoutRef.current) clearTimeout(muerteTimeoutRef.current);
      muerteTimeoutRef.current = setTimeout(() => {
        setMuriendoVisible(false);
        resetearNivel();
      }, MUERTE_MS);
    }

    // La animación de ida ya había llegado al cactus (completarPaso corre
    // después de que animarPaso termina) — rebota de vuelta a la casilla
    // anterior en vez de seguir la cola.
    animarPaso(casillaAnterior, () => setCaminando(false));
  }

  function ejecutarSiguientePaso() {
    const destino = colaRef.current[0];
    if (!destino) return;
    animarPaso(destino, () => completarPaso(destino));
  }

  // Punto de entrada del tap sobre una casilla descubierta: calcula el
  // camino con BFS y lo agenda. Si ya hay un camino en curso, el tap actúa
  // como redirect — el paso que ya está animando (colaRef.current[0]) nunca
  // se interrumpe, el nuevo tramo simplemente continúa desde ahí en cuanto
  // ese paso termine.
  function iniciarCaminoHacia(destino: Coord) {
    if (!progreso || !bioma) return;
    // Gate de niebla: antes vivía en el onPress condicional del Polygon;
    // ahora que el tap se detecta por geometría (Gesture.Tap), tiene que
    // vivir acá para que cualquier llamador quede protegido igual.
    if (!descubiertas.has(claveCoord(destino))) return;

    const enCaminoActual = colaRef.current.length > 0;
    const origenPlanificacion = enCaminoActual ? colaRef.current[0] : { x: progreso.posicion_q, y: progreso.posicion_r };

    // Escalando montaña (parado sobre un tile 'montana'): el movimiento
    // normal por tap queda restringido a las montañas colindantes — no se
    // puede "bajar" por tap, solo con el botón Bajar montaña en un punto de
    // cuerda. A nivel de suelo, la transitabilidad normal (que nunca incluye
    // montaña salvo puente) sigue aplicando.
    const tileOrigenPlanificacion = tilesPorClave.get(claveCoord(origenPlanificacion));
    const predicadoMovimiento =
      tileOrigenPlanificacion?.tipo === 'montana'
        ? (t: TileBioma) => t.tipo === 'montana'
        : crearEsTransitableJugador(puentesConstruidos);

    const tramoNuevo = encontrarCamino(origenPlanificacion, destino, tilesPorClave, predicadoMovimiento);
    if (tramoNuevo === null) {
      mostrarSinCamino(destino);
      return;
    }

    // Cualquier movimiento (nuevo o redirect) recentra la cámara en el
    // personaje y la deja siguiéndolo — si el jugador había arrastrado el
    // mapa para revisar otra zona, tocar una casilla para desplazarse
    // cancela ese paneo manual en vez de dejar al personaje descentrado
    // durante la animación.
    cameraOffsetRef.current = { x: 0, y: 0 };
    setCameraOffset({ x: 0, y: 0 });

    if (enCaminoActual) {
      colaRef.current = [colaRef.current[0], ...tramoNuevo];
    } else {
      colaRef.current = tramoNuevo;
      if (colaRef.current.length > 0) {
        setCaminando(true);
        ejecutarSiguientePaso();
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

  const tieneBancoDeTrabajo = useMemo(
    () => calcularTieneBancoDeTrabajo(inventario, catalogoObjetos),
    [inventario, catalogoObjetos]
  );

  // Filas para el modal de Inventario: los objetos con durabilidad (Hacha/
  // Pico) se listan uno por uno, con su contador de usos — el resto se
  // agrupa por cantidad como antes.
  interface FilaInventario {
    key: string;
    nombre: string;
    cantidad: number;
    usosRestantes?: number;
  }
  const filasInventario = useMemo<FilaInventario[]>(() => {
    const conteoSimple = new Map<string, number>();
    const conDurabilidad: { id: string; nombre: string; usosRestantes: number }[] = [];
    for (const item of inventario) {
      const objeto = catalogoObjetos.get(item.objeto_id);
      if (!objeto) continue;
      if (item.usos_restantes !== null && item.usos_restantes !== undefined) {
        conDurabilidad.push({ id: item.id, nombre: objeto.nombre, usosRestantes: item.usos_restantes });
      } else {
        conteoSimple.set(objeto.nombre, (conteoSimple.get(objeto.nombre) ?? 0) + 1);
      }
    }
    const filas: FilaInventario[] = Array.from(conteoSimple.entries()).map(([nombre, cantidad]) => ({
      key: nombre,
      nombre,
      cantidad,
    }));
    for (const item of conDurabilidad) {
      filas.push({ key: item.id, nombre: item.nombre, cantidad: 1, usosRestantes: item.usosRestantes });
    }
    return filas.sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [inventario, catalogoObjetos]);

  async function abrirCofre() {
    if (!progreso || !descubrimientoId || !tileActual?.cofre) return;
    const clave = claveCoord({ x: progreso.posicion_q, y: progreso.posicion_r });
    if (cofresAbiertos.has(clave)) return;

    const { objetoId, cantidad } = tileActual.cofre;
    const objeto = catalogoObjetos.get(objetoId);
    if (objeto && !hayEspacioPara(inventario, catalogoObjetos, objeto.nombre, cantidad)) {
      mostrarMensaje(`Inventario lleno de ${objeto.nombre}`);
      return;
    }

    const esDurable = objeto ? HERRAMIENTAS_CON_DURABILIDAD.has(objeto.nombre) : false;
    const filas = Array.from({ length: cantidad }, () => ({
      usuario_id: session.user.id,
      objeto_id: objetoId,
      usos_restantes: esDurable ? USOS_INICIALES_HERRAMIENTA : null,
    }));

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

    if (!hayEspacioPara(inventario, catalogoObjetos, objeto.nombre)) {
      mostrarMensaje(`Inventario lleno de ${objeto.nombre}`);
      return;
    }

    // Herramienta con durabilidad usada para recolectar este recurso (Hacha
    // -> madera, Pico -> piedra), si el recurso tiene una asociada — se
    // decrementa 1 uso de una instancia cualquiera del jugador. Lana no
    // tiene herramienta con durabilidad (Tijeras no se gasta).
    const herramienta = herramientaParaRecurso(catalogoObjetos, recurso);
    const instanciaHerramienta =
      herramienta && HERRAMIENTAS_CON_DURABILIDAD.has(herramienta.nombre)
        ? inventario.find((item) => item.objeto_id === herramienta.id && (item.usos_restantes ?? 0) > 0)
        : undefined;

    const { data, error: errInv } = await supabase
      .from('inventario_jugador')
      .insert({ usuario_id: session.user.id, objeto_id: objeto.id, usos_restantes: null })
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

    if (instanciaHerramienta) {
      await descontarUsoHerramienta(instanciaHerramienta, herramienta!.nombre);
    }
  }

  // Descuenta 1 uso de una instancia de herramienta con durabilidad
  // (Hacha/Pico). Avisa al llegar a 1 uso restante y rompe/borra la
  // herramienta del inventario al llegar a 0.
  async function descontarUsoHerramienta(instancia: InventarioItem, nombreHerramienta: string) {
    const usosNuevos = (instancia.usos_restantes ?? 1) - 1;

    if (usosNuevos <= 0) {
      setInventario((actual) => actual.filter((item) => item.id !== instancia.id));
      mostrarMensaje(`Tu ${nombreHerramienta.toLowerCase()} se rompió y desapareció.`);
      const { error: errDelete } = await supabase.from('inventario_jugador').delete().eq('id', instancia.id);
      if (errDelete) setError(errDelete.message);
      return;
    }

    setInventario((actual) =>
      actual.map((item) => (item.id === instancia.id ? { ...item, usos_restantes: usosNuevos } : item))
    );
    if (usosNuevos === 1) {
      mostrarMensaje(`Tu ${nombreHerramienta.toLowerCase()} está a punto de romperse (1 uso restante)`);
    }
    const { error: errUpdate } = await supabase
      .from('inventario_jugador')
      .update({ usos_restantes: usosNuevos })
      .eq('id', instancia.id);
    if (errUpdate) setError(errUpdate.message);
  }

  async function craftear(nombreObjeto: string) {
    const receta = RECETAS_CRAFTEO.find((r) => r.nombreObjeto === nombreObjeto);
    if (!receta || !tieneBancoDeTrabajo) return;
    if (!hayEspacioPara(inventario, catalogoObjetos, nombreObjeto)) {
      mostrarMensaje(`Inventario lleno de ${nombreObjeto}`);
      return;
    }
    for (const { nombreMaterial, cantidad } of receta.costo) {
      if (cantidadDeObjeto(inventario, catalogoObjetos, nombreMaterial) < cantidad) {
        mostrarMensaje(`Te falta ${nombreMaterial}`);
        return;
      }
    }
    const objeto = Array.from(catalogoObjetos.values()).find((o) => o.nombre === nombreObjeto);
    if (!objeto) return;

    // Descuenta los materiales: borra `cantidad` filas por cada material de
    // la receta (cualquiera de las que tenga el jugador de ese material).
    const idsABorrar: string[] = [];
    for (const { nombreMaterial, cantidad } of receta.costo) {
      const instancias = inventario.filter((item) => catalogoObjetos.get(item.objeto_id)?.nombre === nombreMaterial);
      idsABorrar.push(...instancias.slice(0, cantidad).map((item) => item.id));
    }
    const { error: errBorrar } = await supabase.from('inventario_jugador').delete().in('id', idsABorrar);
    if (errBorrar) {
      setError(errBorrar.message);
      return;
    }

    const esDurable = HERRAMIENTAS_CON_DURABILIDAD.has(nombreObjeto);
    const { data, error: errInv } = await supabase
      .from('inventario_jugador')
      .insert({
        usuario_id: session.user.id,
        objeto_id: objeto.id,
        usos_restantes: esDurable ? USOS_INICIALES_HERRAMIENTA : null,
      })
      .select()
      .single();
    if (errInv) {
      setError(errInv.message);
      return;
    }

    setInventario((actual) => [...actual.filter((item) => !idsABorrar.includes(item.id)), data]);
    mostrarMensaje(`Crafteaste ${nombreObjeto}`);
  }

  // Valida cada condición por separado y explica con un mensaje cuál falta
  // en vez de fallar en silencio — el jugador no tiene por qué adivinar que
  // hace falta un río angosto, banco de trabajo o cuánta madera falta.
  async function construirPuente() {
    if (!progreso || !descubrimientoId) return;
    const origen = { x: progreso.posicion_q, y: progreso.posicion_r };

    const objetivo = buscarVecinoRioParaPuente(origen, tilesPorClave, puentesConstruidos);
    if (!objetivo) {
      const vecinoCualquiera = buscarVecinoRioSinPuente(origen, tilesPorClave, puentesConstruidos);
      if (!vecinoCualquiera) {
        mostrarMensaje('Necesitás estar junto a un río para construir un puente');
      } else {
        mostrarMensaje('Ese tramo de río es muy ancho — buscá un tramo de 1 sola casilla');
      }
      return;
    }
    if (!tieneBancoDeTrabajo) {
      mostrarMensaje('Necesitás un banco de trabajo para construir un puente');
      return;
    }
    const cantidadMadera = cantidadDeObjeto(inventario, catalogoObjetos, 'Madera');
    if (cantidadMadera < COSTO_PUENTE_MADERA) {
      mostrarMensaje(`Te faltan ${COSTO_PUENTE_MADERA - cantidadMadera} de madera para el puente`);
      return;
    }

    const madera = Array.from(catalogoObjetos.values()).find((o) => o.nombre === 'Madera');
    if (!madera) return;
    const idsABorrar = inventario
      .filter((item) => item.objeto_id === madera.id)
      .slice(0, COSTO_PUENTE_MADERA)
      .map((item) => item.id);

    const { error: errBorrar } = await supabase.from('inventario_jugador').delete().in('id', idsABorrar);
    if (errBorrar) {
      setError(errBorrar.message);
      return;
    }
    setInventario((actual) => actual.filter((item) => !idsABorrar.includes(item.id)));

    const nuevosPuentes = new Map(puentesConstruidos);
    nuevosPuentes.set(claveCoord(objetivo), objetivo);
    setPuentesConstruidos(nuevosPuentes);
    mostrarMensaje('Puente construido');

    const { error: errPuentes } = await supabase
      .from('descubrimiento_jugador')
      .update({ puentes_construidos: Array.from(nuevosPuentes.values()) })
      .eq('id', descubrimientoId);
    if (errPuentes) setError(errPuentes.message);

    // Revela lo que quede visible del otro lado del río recién puenteado.
    const actualizadas = fusionarDescubiertas(
      descubiertasRef.current,
      origen,
      tilesPorClave,
      RADIO_VISION_DEFAULT,
      crearEsTransitableJugador(nuevosPuentes)
    );
    if (actualizadas.size !== descubiertasRef.current.size) {
      descubiertasRef.current = actualizadas;
      setDescubiertas(actualizadas);
      const { error: errDesc } = await supabase
        .from('descubrimiento_jugador')
        .update({ casillas_descubiertas: Array.from(actualizadas.values()) })
        .eq('id', descubrimientoId);
      if (errDesc) setError(errDesc.message);
    }
  }

  // Igual que construirPuente: valida cada condición por separado y explica
  // con un mensaje cuál falta, en vez de fallar en silencio.
  async function colocarCuerda() {
    if (!progreso || !descubrimientoId || !tileActual) return;

    const cercaDeMontana =
      tileActual.tipo === 'montana' ||
      vecinos(tileActual).some((v) => tilesPorClave.get(claveCoord(v))?.tipo === 'montana');
    if (!cercaDeMontana) {
      mostrarMensaje('Necesitás estar junto a una montaña para usar la cuerda');
      return;
    }

    const par = buscarParParaCuerda(tileActual, tilesPorClave);
    if (!par) {
      // Solo puede fallar acá parado EN la montaña: no hay ninguna casilla
      // de arena vacía (sin recurso ni cofre) al lado para bajar.
      mostrarMensaje('No hay una casilla de arena vacía al lado para bajar la cuerda');
      return;
    }
    if (cuerdasConstruidas.some((c) => coordsIguales(c.suelo, par.suelo) && coordsIguales(c.montana, par.montana))) {
      mostrarMensaje('Ya hay una cuerda colocada ahí');
      return;
    }

    const cuerdaObjeto = Array.from(catalogoObjetos.values()).find((o) => o.nombre === 'Cuerda');
    const instancia = cuerdaObjeto ? inventario.find((item) => item.objeto_id === cuerdaObjeto.id) : undefined;
    if (!instancia) {
      mostrarMensaje('Necesitás una Cuerda en el inventario');
      return;
    }

    const { error: errBorrar } = await supabase.from('inventario_jugador').delete().eq('id', instancia.id);
    if (errBorrar) {
      setError(errBorrar.message);
      return;
    }
    setInventario((actual) => actual.filter((item) => item.id !== instancia.id));

    const nuevasCuerdas = [...cuerdasConstruidas, par];
    setCuerdasConstruidas(nuevasCuerdas);
    mostrarMensaje('Cuerda colocada');

    const { error: errCuerdas } = await supabase
      .from('descubrimiento_jugador')
      .update({ cuerdas_construidas: nuevasCuerdas })
      .eq('id', descubrimientoId);
    if (errCuerdas) setError(errCuerdas.message);
  }

  // Subir/bajar son un solo paso: reusan la misma cola/animación que el
  // movimiento normal en vez de código nuevo (ver ejecutarSiguientePaso).
  function subirMontana() {
    if (!tileActual || caminando) return;
    const cuerda = buscarCuerdaPorSuelo(cuerdasConstruidas, tileActual);
    if (!cuerda) return;
    cameraOffsetRef.current = { x: 0, y: 0 };
    setCameraOffset({ x: 0, y: 0 });
    colaRef.current = [cuerda.montana];
    setCaminando(true);
    ejecutarSiguientePaso();
  }

  function bajarMontana() {
    if (!tileActual || caminando) return;
    const cuerda = buscarCuerdaPorMontana(cuerdasConstruidas, tileActual);
    if (!cuerda) return;
    cameraOffsetRef.current = { x: 0, y: 0 };
    setCameraOffset({ x: 0, y: 0 });
    colaRef.current = [cuerda.suelo];
    setCaminando(true);
    ejecutarSiguientePaso();
  }

  // La Poción restaura la vida al máximo y se consume al usarla.
  async function usarPocion() {
    if (!progreso) return;
    const pocionObjeto = Array.from(catalogoObjetos.values()).find((o) => o.nombre === 'Poción');
    const instancia = pocionObjeto ? inventario.find((item) => item.objeto_id === pocionObjeto.id) : undefined;
    if (!instancia) return;

    const { error: errBorrar } = await supabase.from('inventario_jugador').delete().eq('id', instancia.id);
    if (errBorrar) {
      setError(errBorrar.message);
      return;
    }
    setInventario((actual) => actual.filter((item) => item.id !== instancia.id));

    const progresoActualizado = { ...progreso, vida_actual: VIDA_MAXIMA };
    progresoRef.current = progresoActualizado;
    setProgreso(progresoActualizado);
    mostrarMensaje('Vida restaurada');

    const { error: errVida } = await supabase
      .from('progreso_jugador')
      .update({ vida_actual: VIDA_MAXIMA })
      .eq('id', progreso.id);
    if (errVida) setError(errVida.message);
  }

  // Reinicia el nivel desde cero: borra todo el inventario (salvo un Hacha
  // nueva, con la que el jugador siempre arranca), vuelve al spawn con la
  // vida al máximo, y resetea todo lo descubierto/crafteado (niebla, cofres
  // abiertos, recursos recolectados, puentes y cuerdas construidos) — al
  // vaciarse el inventario, lo crafteado con él queda reseteado también.
  async function resetearNivel() {
    setResetVisible(false);
    if (!progreso || !bioma || !descubrimientoId) return;

    const idsABorrar = inventario.map((item) => item.id);
    if (idsABorrar.length > 0) {
      const { error: errBorrar } = await supabase.from('inventario_jugador').delete().in('id', idsABorrar);
      if (errBorrar) {
        setError(errBorrar.message);
        return;
      }
    }

    let inventarioNuevo: InventarioItem[] = [];
    const hacha = Array.from(catalogoObjetos.values()).find((o) => o.nombre === 'Hacha');
    if (hacha) {
      const { data: hachaInicial, error: errHacha } = await supabase
        .from('inventario_jugador')
        .insert({ usuario_id: session.user.id, objeto_id: hacha.id, usos_restantes: USOS_INICIALES_HERRAMIENTA })
        .select()
        .single();
      if (errHacha) {
        setError(errHacha.message);
        return;
      }
      inventarioNuevo = [hachaInicial];
    }
    setInventario(inventarioNuevo);

    const spawn = bioma.tiles.spawn;
    const progresoActualizado = { ...progreso, posicion_q: spawn.x, posicion_r: spawn.y, vida_actual: VIDA_MAXIMA };
    progresoRef.current = progresoActualizado;
    posicionVisualRef.current = spawn;
    setProgreso(progresoActualizado);
    setPosicionVisual(spawn);
    const { error: errProgreso } = await supabase
      .from('progreso_jugador')
      .update({ posicion_q: spawn.x, posicion_r: spawn.y, vida_actual: VIDA_MAXIMA })
      .eq('id', progreso.id);
    if (errProgreso) setError(errProgreso.message);

    setCofresAbiertos(new Map());
    setRecursosRecolectados(new Map());
    setPuentesConstruidos(new Map());
    setCuerdasConstruidas([]);
    const reveladas = fusionarDescubiertas(new Map(), spawn, tilesPorClave, RADIO_VISION_DEFAULT, crearEsTransitableJugador(new Map()));
    descubiertasRef.current = reveladas;
    setDescubiertas(reveladas);
    const { error: errDesc } = await supabase
      .from('descubrimiento_jugador')
      .update({
        casillas_descubiertas: Array.from(reveladas.values()),
        cofres_abiertos: [],
        recursos_recolectados: [],
        puentes_construidos: [],
        cuerdas_construidas: [],
      })
      .eq('id', descubrimientoId);
    if (errDesc) setError(errDesc.message);

    mostrarMensaje('Nivel reiniciado');
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

  // "Construir puente" aparece con solo estar junto a CUALQUIER río sin
  // puente (sin importar ancho, banco de trabajo o madera) — el resto de
  // las condiciones las valida y explica construirPuente() al tocarlo, en
  // vez de que el botón directamente no aparezca.
  const vecinoRioParaPuente =
    !caminando && tileActual ? buscarVecinoRioSinPuente(tileActual, tilesPorClave, puentesConstruidos) : undefined;
  const mostrarBotonPuente = !!vecinoRioParaPuente;

  // "Colocar cuerda" aparece con solo estar al lado o encima de CUALQUIER
  // montaña — el resto de las condiciones (casilla vacía para bajar, cuerda
  // duplicada, Cuerda en inventario) las valida y explica colocarCuerda() al
  // tocarlo.
  const mostrarBotonColocarCuerda =
    !caminando &&
    !!tileActual &&
    (tileActual.tipo === 'montana' ||
      vecinos(tileActual).some((v) => tilesPorClave.get(claveCoord(v))?.tipo === 'montana'));

  // "Subir montaña": parado justo en el lado "suelo" de una cuerda ya
  // colocada. "Bajar montaña": parado en el lado "montaña" de cualquier
  // cuerda (no necesariamente la misma por la que subió).
  const cuerdaParaSubir = !caminando && tileActual ? buscarCuerdaPorSuelo(cuerdasConstruidas, tileActual) : undefined;
  const mostrarBotonSubir = !!cuerdaParaSubir;
  const cuerdaParaBajar =
    !caminando && tileActual?.tipo === 'montana' ? buscarCuerdaPorMontana(cuerdasConstruidas, tileActual) : undefined;
  const mostrarBotonBajar = !!cuerdaParaBajar;

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
          <Text style={styles.subtitulo}>
            Vida: {progreso.vida_actual}/{VIDA_MAXIMA}
          </Text>
        </View>
        <View style={styles.accionesEncabezado}>
          <TouchableOpacity onPress={() => setInventarioVisible(true)}>
            <Text style={styles.enlace}>Inventario ({inventario.length})</Text>
          </TouchableOpacity>
          {tieneBancoDeTrabajo && (
            <TouchableOpacity onPress={() => setCrafteoVisible(true)}>
              <Text style={styles.enlace}>Crear</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setResetVisible(true)}>
            <Text style={styles.enlace}>Reiniciar nivel</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setAyudaVisible(true)}>
            <Text style={styles.enlace}>Ayuda</Text>
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
            {filasInventario.length === 0 ? (
              <Text style={styles.modalVacio}>Todavía no tenés objetos.</Text>
            ) : (
              filasInventario.map((fila) => (
                <View key={fila.key} style={styles.modalFila}>
                  <Text style={styles.modalObjetoNombre}>{fila.nombre}</Text>
                  <Text style={styles.modalObjetoCantidad}>
                    {fila.usosRestantes !== undefined ? `${fila.usosRestantes} usos` : `x${fila.cantidad}`}
                  </Text>
                  {fila.nombre === 'Poción' && (
                    <TouchableOpacity style={styles.boton} onPress={usarPocion}>
                      <Text style={styles.botonTexto}>Usar</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))
            )}
            <TouchableOpacity style={styles.boton} onPress={() => setInventarioVisible(false)}>
              <Text style={styles.botonTexto}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={crafteoVisible} transparent animationType="fade" onRequestClose={() => setCrafteoVisible(false)}>
        <View style={styles.modalFondo}>
          <View style={styles.modalContenido}>
            <Text style={styles.modalTitulo}>Crear (banco de trabajo)</Text>
            {RECETAS_CRAFTEO.map((receta) => {
              const tope = topeInventario(receta.nombreObjeto);
              const cantidadActual = cantidadDeObjeto(inventario, catalogoObjetos, receta.nombreObjeto);
              const alTope = tope !== null && cantidadActual >= tope;
              const faltaMaterial = receta.costo.some(
                ({ nombreMaterial, cantidad }) => cantidadDeObjeto(inventario, catalogoObjetos, nombreMaterial) < cantidad
              );
              const deshabilitado = alTope || faltaMaterial;
              const textoCosto = receta.costo.map(({ nombreMaterial, cantidad }) => `${cantidad} ${nombreMaterial}`).join(' + ');
              return (
                <View key={receta.nombreObjeto} style={styles.modalFila}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modalObjetoNombre}>{receta.nombreObjeto}</Text>
                    <Text style={styles.textoFaltaHerramienta}>
                      {textoCosto}
                      {alTope ? ' · al tope' : ''}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.boton, deshabilitado && styles.botonDeshabilitado]}
                    disabled={deshabilitado}
                    onPress={() => craftear(receta.nombreObjeto)}
                  >
                    <Text style={styles.botonTexto}>Craftear</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
            <TouchableOpacity style={styles.boton} onPress={() => setCrafteoVisible(false)}>
              <Text style={styles.botonTexto}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={resetVisible} transparent animationType="fade" onRequestClose={() => setResetVisible(false)}>
        <View style={styles.modalFondo}>
          <View style={styles.modalContenido}>
            <Text style={styles.modalTitulo}>¿Reiniciar el nivel?</Text>
            <Text style={styles.modalVacio}>
              Volvés al punto de salida con la vida al máximo. Se borra todo el inventario y lo crafteado — solo
              conservás un Hacha.
            </Text>
            <TouchableOpacity style={styles.boton} onPress={resetearNivel}>
              <Text style={styles.botonTexto}>Sí, reiniciar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.boton} onPress={() => setResetVisible(false)}>
              <Text style={styles.botonTexto}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={ayudaVisible} transparent animationType="fade" onRequestClose={() => setAyudaVisible(false)}>
        <View style={styles.modalFondo}>
          <View style={styles.modalContenido}>
            <Text style={styles.modalTitulo}>Ayuda</Text>

            <Text style={styles.modalSubtitulo}>Puente</Text>
            <Text style={styles.modalVacio}>
              Parate justo al lado de un tramo de río de 1 sola casilla de ancho (no sirve en tramos anchos o
              confluencias). Necesitás un banco de trabajo y 10 de madera. Si intentás construirlo sin cumplir algo,
              el juego te dice exactamente qué te falta.
            </Text>

            <Text style={styles.modalSubtitulo}>Cuerda</Text>
            <Text style={styles.modalVacio}>
              Se craftea con 5 de lana en el banco de trabajo. Para colocarla y subir, parate al lado de una montaña.
              Para colocar una nueva cuerda que sirva para bajar, parate arriba de la montaña, al lado de una casilla
              de arena vacía (sin recurso ni cofre).
            </Text>

            <Text style={styles.modalSubtitulo}>Bajar de una montaña</Text>
            <Text style={styles.modalVacio}>
              Una vez arriba solo podés caminar por casillas de montaña, no podés bajar caminando directo a la
              arena. Para bajar usá "Bajar montaña" parado en el punto de la cuerda que usaste para subir, o en el
              de cualquier otra cuerda que hayas colocado desde ahí arriba.
            </Text>

            <TouchableOpacity style={styles.boton} onPress={() => setAyudaVisible(false)}>
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

              const esPuenteTile = tile.tipo === 'rio' && puentesConstruidos.has(clave);
              const cuerdaEnEsteMontana =
                tile.tipo === 'montana' ? cuerdasConstruidas.find((c) => coordsIguales(c.montana, tile)) : undefined;
              const relleno = revelada ? (esPuenteTile ? COLOR_PUENTE : colorTile(tile.tipo)) : '#1B2536';
              // Textura solo en tiles revelados — si se dibujara también en
              // niebla, la silueta (montaña, río) se filtraría a través del
              // fill oscuro de fog, que es una capa aparte con su propio alfa.
              const textura = revelada
                ? esPuenteTile
                  ? TEXTURA_PUENTE
                  : texturaParaTile(
                      tile,
                      tilesPorClave,
                      recursosRecolectados.has(clave),
                      cofresAbiertos.has(clave),
                      cuerdaEnEsteMontana
                    )
                : null;

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
                        x={-(textura.ancho ?? ANCHO_TILE) / 2}
                        y={textura.centrado ? -textura.alto / 2 : -ALTO_TILE / 2}
                        width={textura.ancho ?? ANCHO_TILE}
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
                  (DEBUG_SIN_FOG || descubiertas.has(claveCoord(tile))) &&
                  tile.recurso &&
                  !recursosRecolectados.has(claveCoord(tile)) &&
                  // 'arbol', piedra, lana y madera ya tienen su propia
                  // textura de tile completo (dead-tree/mining-rock/sheep)
                  // — el ícono encima sería redundante. Este bloque queda
                  // como fallback genérico para el día que se agregue un
                  // material nuevo sin arte propia todavía.
                  tile.tipo !== 'arbol' &&
                  tile.recurso !== 'piedra' &&
                  tile.recurso !== 'lana' &&
                  tile.recurso !== 'madera'
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

          {golpeCactus && <View pointerEvents="none" style={styles.flashDano} />}

          {muriendoVisible && (
            <View pointerEvents="none" style={styles.overlayMuerte}>
              <Text style={styles.textoMuerte}>HAS MUERTO...</Text>
            </View>
          )}

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

      {(mostrarBotonCofre ||
        mostrarBotonRecurso ||
        mostrarBotonPuente ||
        mostrarBotonColocarCuerda ||
        mostrarBotonSubir ||
        mostrarBotonBajar) && (
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
          {mostrarBotonPuente && (
            <TouchableOpacity style={styles.boton} onPress={construirPuente}>
              <Text style={styles.botonTexto}>Construir puente</Text>
            </TouchableOpacity>
          )}
          {mostrarBotonColocarCuerda && (
            <TouchableOpacity style={styles.boton} onPress={colocarCuerda}>
              <Text style={styles.botonTexto}>Colocar cuerda</Text>
            </TouchableOpacity>
          )}
          {mostrarBotonSubir && (
            <TouchableOpacity style={styles.boton} onPress={subirMontana}>
              <Text style={styles.botonTexto}>Subir montaña</Text>
            </TouchableOpacity>
          )}
          {mostrarBotonBajar && (
            <TouchableOpacity style={styles.boton} onPress={bajarMontana}>
              <Text style={styles.botonTexto}>Bajar montaña</Text>
            </TouchableOpacity>
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
  flashDano: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(220, 38, 38, 0.35)',
  },
  overlayMuerte: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(246, 239, 216, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  textoMuerte: {
    color: '#000000',
    fontSize: 40,
    fontWeight: '900',
    textAlign: 'center',
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
  modalSubtitulo: {
    color: '#F6EFD8',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
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
