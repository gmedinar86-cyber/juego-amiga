import type { Coord } from './isoGrid';

export interface CofreTile {
  objetoId: string;
  cantidad: number;
}

export interface TileBioma extends Coord {
  tipo: string;
  recurso: string | null;
  cofre?: CofreTile | null;
  // Marcador temporal del generador (ver esparcirCofres en
  // generadorTerreno.ts): el generador no tiene acceso a la DB, así que no
  // puede resolver un objetoId real. Guarda el *nombre* del objeto y un SQL
  // aparte lo resuelve a `cofre` (con el objetoId real) antes de guardarse
  // en Supabase — el cliente nunca debería ver este campo en producción.
  cofrePendiente?: string | null;
}

export interface GridBioma {
  n: number;
  spawn: Coord;
  portal: Coord;
  tiles: TileBioma[];
  // Ubicaciones guardadas para más adelante — todavía sin lógica de combate,
  // solo se persisten junto con el resto del grid (ver 'enemigo'/'jefe_final'
  // en texturaParaTile/colorTile, PantallaJuego.tsx).
  enemigos?: Coord[];
  jefe_final?: Coord;
}

export interface Bioma {
  id: string;
  nombre: string;
  nivel_dificultad: number;
  tiles: GridBioma;
  creado_en: string;
}

export interface ProgresoJugador {
  id: string;
  usuario_id: string;
  nivel: number;
  fuerza: number;
  vida_maxima: number;
  vida_actual: number;
  clase_actual_id: string | null;
  bioma_actual_id: string | null;
  // posicion_q/posicion_r son columnas genéricas en Supabase; aquí guardan x/y del grid isométrico.
  posicion_q: number;
  posicion_r: number;
  actualizado_en: string;
}

export interface CuerdaConstruida {
  suelo: Coord;
  montana: Coord;
}

export interface DescubrimientoJugador {
  id: string;
  usuario_id: string;
  bioma_id: string;
  casillas_descubiertas: Coord[];
  cofres_abiertos: Coord[];
  recursos_recolectados: Coord[];
  puentes_construidos: Coord[];
  cuerdas_construidas: CuerdaConstruida[];
}

export interface Objeto {
  id: string;
  nombre: string;
  tipo: string;
  efecto: { recolecta?: string } | null;
  bioma_id: string | null;
}

export interface InventarioItem {
  id: string;
  usuario_id: string;
  objeto_id: string;
  obtenido_en: string;
  // Solo se completa para instancias de Hacha/Pico (arranca en 10, se
  // decrementa por uso — ver recolectar() en PantallaJuego.tsx). El resto de
  // items (materiales, Tijeras, Banco de trabajo, Cuerda, Poción) la deja en
  // null.
  usos_restantes: number | null;
}
