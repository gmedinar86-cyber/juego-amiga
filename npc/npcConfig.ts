// npcConfig.ts
//
// Configuración data-driven de cada tipo de NPC. Agregar un NPC nuevo es
// solo agregar una entrada acá (y, si hace falta un sprite propio, la
// textura correspondiente en la pantalla del juego) — no hace falta tocar
// npcController.ts.

export interface NPCConfig {
  tipo: string;       // "momia", "buitre", etc. — debe matchear la textura en PantallaJuego
  rango: number;       // radio máximo (en casillas) desde el punto de spawn en el que puede moverse
  velocidad: number;   // ms entre cada movimiento
  activo: boolean;      // si está en false, iniciar() no arranca el loop de movimiento
}

export const MOMIA_CONFIG: NPCConfig = {
  tipo: "momia",
  rango: 1,
  velocidad: 1000, // 2 segundos
  activo: false,
};

export const BUITRE_CONFIG: NPCConfig = {
  tipo: "buitre",
  rango: 5,
  velocidad: 1200, // más rápido que la momia
  activo: true,
};
