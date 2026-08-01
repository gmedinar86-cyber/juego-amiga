import type { Coord } from './isoGrid';

export interface TileBioma extends Coord {
  tipo: string;
  recurso: string | null;
}

export interface GridBioma {
  n: number;
  spawn: Coord;
  portal: Coord;
  tiles: TileBioma[];
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
  clase_actual_id: string | null;
  bioma_actual_id: string | null;
  // posicion_q/posicion_r son columnas genéricas en Supabase; aquí guardan x/y del grid isométrico.
  posicion_q: number;
  posicion_r: number;
  actualizado_en: string;
}

export interface DescubrimientoJugador {
  id: string;
  usuario_id: string;
  bioma_id: string;
  casillas_descubiertas: Coord[];
}
