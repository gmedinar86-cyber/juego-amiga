import type { InventarioItem, Objeto } from './tipos';

// Qué tipos de recurso puede recolectar el jugador ahora mismo, derivado de
// las herramientas en su inventario. Data-driven vía `objeto.efecto.recolecta`
// — agregar un nuevo par herramienta/material no requiere tocar este código.
export function recursosHabilitados(inventario: InventarioItem[], catalogo: Map<string, Objeto>): Set<string> {
  const habilitados = new Set<string>();
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
