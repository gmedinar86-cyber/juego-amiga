import type { InventarioItem, Objeto } from './tipos';

// Qué tipos de recurso puede recolectar el jugador ahora mismo, derivado de
// las herramientas en su inventario. Data-driven vía `objeto.efecto.recolecta`
// — agregar un nuevo par herramienta/material no requiere tocar este código.
// Un material (ej. lana) que ningún objeto del catálogo declara como
// `efecto.recolecta` de una herramienta se considera de recolección libre —
// no hace falta tener nada en el inventario para juntarlo.
export function recursosHabilitados(inventario: InventarioItem[], catalogo: Map<string, Objeto>): Set<string> {
  const recursosConHerramienta = new Set<string>();
  for (const objeto of catalogo.values()) {
    if (objeto.tipo === 'herramienta' && objeto.efecto?.recolecta) {
      recursosConHerramienta.add(objeto.efecto.recolecta);
    }
  }

  const habilitados = new Set<string>();
  for (const objeto of catalogo.values()) {
    if (objeto.tipo === 'material' && !recursosConHerramienta.has(objeto.nombre.toLowerCase())) {
      habilitados.add(objeto.nombre.toLowerCase());
    }
  }
  for (const item of inventario) {
    const objeto = catalogo.get(item.objeto_id);
    if (objeto?.tipo === 'herramienta' && objeto.efecto?.recolecta) {
      habilitados.add(objeto.efecto.recolecta);
    }
  }
  return habilitados;
}

// El objeto de catálogo (tipo 'material') que corresponde a un recurso de
// tile, por nombre (ej. tile.recurso === 'madera' -> objeto "Madera").
export function objetoParaRecurso(catalogo: Map<string, Objeto>, recurso: string): Objeto | undefined {
  for (const objeto of catalogo.values()) {
    if (objeto.tipo === 'material' && objeto.nombre.toLowerCase() === recurso.toLowerCase()) {
      return objeto;
    }
  }
  return undefined;
}

// La herramienta (tipo 'herramienta') requerida para recolectar un recurso,
// usada solo para mostrar el nombre en el indicador de "falta herramienta".
export function herramientaParaRecurso(catalogo: Map<string, Objeto>, recurso: string): Objeto | undefined {
  for (const objeto of catalogo.values()) {
    if (objeto.tipo === 'herramienta' && objeto.efecto?.recolecta === recurso) {
      return objeto;
    }
  }
  return undefined;
}

// Cuántas unidades de un objeto (por nombre) puede cargar el jugador a la
// vez. Sin entrada acá = sin tope (ej. Banco de trabajo, que además nunca
// debería poder craftearse/recogerse dos veces — ver cantidadDeObjeto).
const TOPES_INVENTARIO: Record<string, number> = {
  Piedra: 5,
  Madera: 15,
  Lana: 10,
  Pico: 2,
  Hacha: 2,
  Cuerda: 2,
};

export function topeInventario(nombreObjeto: string): number | null {
  return TOPES_INVENTARIO[nombreObjeto] ?? null;
}

// Cuántas instancias de un objeto (por nombre) tiene ya el jugador.
export function cantidadDeObjeto(inventario: InventarioItem[], catalogo: Map<string, Objeto>, nombreObjeto: string): number {
  return inventario.filter((item) => catalogo.get(item.objeto_id)?.nombre === nombreObjeto).length;
}

// true si agregar `cantidadNueva` unidades de `nombreObjeto` no pisa el tope
// de TOPES_INVENTARIO (o si el objeto no tiene tope definido).
export function hayEspacioPara(
  inventario: InventarioItem[],
  catalogo: Map<string, Objeto>,
  nombreObjeto: string,
  cantidadNueva: number = 1
): boolean {
  const tope = topeInventario(nombreObjeto);
  if (tope === null) return true;
  return cantidadDeObjeto(inventario, catalogo, nombreObjeto) + cantidadNueva <= tope;
}

export function tieneBancoDeTrabajo(inventario: InventarioItem[], catalogo: Map<string, Objeto>): boolean {
  return cantidadDeObjeto(inventario, catalogo, 'Banco de trabajo') > 0;
}

// Herramientas que se gastan con el uso (ver usos_restantes en
// InventarioItem) — el resto (Tijeras, Banco de trabajo, Cuerda) no se
// rompen por uso.
export const HERRAMIENTAS_CON_DURABILIDAD = new Set(['Hacha', 'Pico']);
export const USOS_INICIALES_HERRAMIENTA = 10;

export interface RecetaCrafteo {
  nombreObjeto: string;
  costo: { nombreMaterial: string; cantidad: number }[];
}

// Recetas de crafteo en el banco de trabajo. Puentes no craftean acá: se
// construyen directo en el lugar (ver "Construir puente" en la pantalla).
export const RECETAS_CRAFTEO: RecetaCrafteo[] = [
  { nombreObjeto: 'Hacha', costo: [{ nombreMaterial: 'Piedra', cantidad: 1 }, { nombreMaterial: 'Madera', cantidad: 3 }] },
  { nombreObjeto: 'Pico', costo: [{ nombreMaterial: 'Piedra', cantidad: 1 }, { nombreMaterial: 'Madera', cantidad: 3 }] },
  { nombreObjeto: 'Cuerda', costo: [{ nombreMaterial: 'Lana', cantidad: 3 }] },
];

