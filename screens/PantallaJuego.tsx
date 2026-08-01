import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Polygon } from 'react-native-svg';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import {
  claveCoord,
  claveProfundidad,
  coordsEnRadio,
  esquinasRombo,
  isoAPixel,
  type Coord,
} from '../lib/isoGrid';
import { encontrarCamino } from '../lib/pathfinding';
import type { Bioma, DescubrimientoJugador, ProgresoJugador, TileBioma } from '../lib/tipos';

const RADIO_VISION_DEFAULT = 1;
const RADIO_VISION_MONTANA = 3;
const DURACION_PASO_MS = 200;
const SIN_CAMINO_FLASH_MS = 350;
const ANCHO_TILE = 72;
const ALTO_TILE = 36;
const CAMARA_RADIO = 2.5;
const SEMI_ANCHO_BASE = CAMARA_RADIO * ANCHO_TILE;
const SEMI_ALTO_BASE = CAMARA_RADIO * ALTO_TILE;
const ZOOM_MIN_ABSOLUTO = 0.05;
const ZOOM_MAX = 2.5;
const UMBRAL_SNAP = 0.85;
const MARGEN_ZOOM_ALEJADO = 1.15;

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

  function fusionarDescubiertas(
    actuales: Map<string, Coord>,
    centro: Coord,
    tilesGrid: TileBioma[],
    radio: number = RADIO_VISION_DEFAULT
  ): Map<string, Coord> {
    const clavesGrid = new Set(tilesGrid.map(claveCoord));
    const resultado = new Map(actuales);
    for (const c of coordsEnRadio(centro, radio)) {
      const k = claveCoord(c);
      if (clavesGrid.has(k)) resultado.set(k, c);
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
      const reveladas = fusionarDescubiertas(previas, posicionActual, biomaData.tiles.tiles);

      if (descData) {
        setDescubrimientoId(descData.id);
        if (reveladas.size !== previas.size) {
          await supabase
            .from('descubrimiento_jugador')
            .update({ casillas_descubiertas: Array.from(reveladas.values()) })
            .eq('id', descData.id);
        }
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
      }

      const posicionInicial: Coord = { x: progresoData.posicion_q, y: progresoData.posicion_r };
      posicionVisualRef.current = posicionInicial;
      descubiertasRef.current = reveladas;

      setProgreso(progresoData);
      setBioma(biomaData);
      setDescubiertas(reveladas);
      setPosicionVisual(posicionInicial);
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
    const radio = tileDestino?.tipo === 'montana' ? RADIO_VISION_MONTANA : RADIO_VISION_DEFAULT;

    const actualizadas = fusionarDescubiertas(descubiertasRef.current, destinoPaso, bioma.tiles.tiles, radio);
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
    }
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

    const enCaminoActual = colaRef.current.length > 0;
    const origenPlanificacion = enCaminoActual ? colaRef.current[0] : { x: progreso.posicion_q, y: progreso.posicion_r };

    const tramoNuevo = encontrarCamino(origenPlanificacion, destino, tilesPorClave);
    if (tramoNuevo === null) {
      mostrarSinCamino(destino);
      return;
    }

    if (enCaminoActual) {
      colaRef.current = [colaRef.current[0], ...tramoNuevo];
    } else {
      colaRef.current = tramoNuevo;
      if (colaRef.current.length > 0) {
        ejecutarSiguientePaso();
      }
    }
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

  const gestoPan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(10)
        .onBegin(() => {
          offsetInicioGesto.current = cameraOffsetRef.current;
        })
        .onUpdate((e) => {
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
        .onEnd(() => {
          const semiAncho = SEMI_ANCHO_BASE / zoomRef.current;
          const semiAlto = SEMI_ALTO_BASE / zoomRef.current;
          const actual = cameraOffsetRef.current;
          if (Math.abs(actual.x) / semiAncho > UMBRAL_SNAP || Math.abs(actual.y) / semiAlto > UMBRAL_SNAP) {
            setCameraOffset({ x: 0, y: 0 });
          }
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

  const gestoCompuesto = useMemo(() => Gesture.Simultaneous(gestoPan, gestoPinch), [gestoPan, gestoPinch]);

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

  return (
    <View style={styles.contenedor}>
      <View style={styles.encabezado}>
        <View>
          <Text style={styles.titulo}>{bioma.nombre}</Text>
          <Text style={styles.subtitulo}>
            Nivel {progreso.nivel} · Fuerza {progreso.fuerza}
          </Text>
        </View>
        <TouchableOpacity onPress={() => supabase.auth.signOut()}>
          <Text style={styles.enlace}>Cerrar sesión</Text>
        </TouchableOpacity>
      </View>

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

              return (
                <Polygon
                  key={clave}
                  points={puntosPoligono}
                  fill={relleno}
                  stroke={sinCamino ? '#E8746A' : '#2C394D'}
                  strokeWidth={sinCamino ? 2.5 : 1}
                  onPress={descubierta ? () => iniciarCaminoHacia(tile) : undefined}
                />
              );
            })}

            {geometria.puntos
              .filter(({ tile }) => descubiertas.has(claveCoord(tile)) && tile.recurso)
              .map(({ tile, pixel }) => (
                <Circle key={`recurso-${claveCoord(tile)}`} cx={pixel.x} cy={pixel.y} r={5} fill="#7BC96F" />
              ))}

            {(() => {
              const pixelJugador = isoAPixel(posicionVisual, ANCHO_TILE, ALTO_TILE);
              return <Circle cx={pixelJugador.x} cy={pixelJugador.y} r={9} fill="#F4B93F" stroke="#1D2A38" strokeWidth={2} />;
            })()}
          </Svg>

          <TouchableOpacity style={styles.botonCentrar} onPress={() => setCameraOffset({ x: 0, y: 0 })}>
            <Text style={styles.botonCentrarTexto}>Centrar</Text>
          </TouchableOpacity>
        </View>
      </GestureDetector>

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
  error: {
    color: '#E8746A',
    textAlign: 'center',
    fontSize: 14,
  },
});
