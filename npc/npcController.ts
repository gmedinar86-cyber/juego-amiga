// npcController.ts
//
// Cada instancia controla UN npc: guarda su posición actual, y sabe cómo
// moverse solo (random walk restringido a las casillas transitables dentro
// de `rango` desde su punto de spawn). PantallaJuego solo necesita:
//   const npc = new NPCController(MOMIA_CONFIG, { x, y });
//   npc.iniciar(tilesPorClave, () => forzarRerender());
//   ...
//   npc.detener();
// y leer npc.pos / npc.config.tipo para dibujarlo.

import { claveCoord, vecinos, type Coord } from '../lib/isoGrid';
import { esTransitable } from '../lib/generadorTerreno';
import type { TileBioma } from '../lib/tipos';
import type { NPCConfig } from './npcConfig';

export class NPCController {
  readonly config: NPCConfig;
  pos: Coord;

  private readonly origen: Coord;
  private tilesPorClave: Map<string, TileBioma> = new Map();
  private onMove: () => void = () => {};
  private intervaloId: ReturnType<typeof setInterval> | null = null;

  constructor(config: NPCConfig, posInicial: Coord) {
    this.config = config;
    this.pos = { ...posInicial };
    this.origen = { ...posInicial };
  }

  /**
   * Arranca el loop de movimiento. `tilesPorClave` es el mismo Map que ya
   * arma PantallaJuego (claveCoord -> TileBioma) para poder validar a qué
   * casillas se puede mover. `onMove` se llama después de cada paso, para
   * que el llamador pueda forzar un re-render (ver tickNPC en
   * PantallaJuego).
   */
  iniciar(tilesPorClave: Map<string, TileBioma>, onMove: () => void) {
    this.tilesPorClave = tilesPorClave;
    this.onMove = onMove;

    // Reinicia cualquier loop anterior (por si iniciar() se llama de nuevo,
    // p.ej. cuando cambia el bioma y PantallaJuego recrea el NPC).
    this.detener();

    if (!this.config.activo) return;

    this.intervaloId = setInterval(() => {
      this.moverAleatorio();
    }, this.config.velocidad);
  }

  detener() {
    if (this.intervaloId !== null) {
      clearInterval(this.intervaloId);
      this.intervaloId = null;
    }
  }

  private dentroDelRango(coord: Coord): boolean {
    return (
      Math.abs(coord.x - this.origen.x) <= this.config.rango &&
      Math.abs(coord.y - this.origen.y) <= this.config.rango
    );
  }

  private moverAleatorio() {
    if (this.tilesPorClave.size === 0) return;

    const candidatos = vecinos(this.pos).filter((v) => {
      if (!this.dentroDelRango(v)) return false;
      const tile = this.tilesPorClave.get(claveCoord(v));
      return !!tile && esTransitable(tile);
    });

    if (candidatos.length === 0) return; // acorralado o sin vecinos válidos: se queda quieto este tick

    const destino = candidatos[Math.floor(Math.random() * candidatos.length)];
    this.pos = destino;
    this.onMove();
  }
}
