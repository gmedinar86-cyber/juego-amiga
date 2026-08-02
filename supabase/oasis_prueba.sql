-- Oasis de prueba: el generador de terreno todavía no produce tiles tipo
-- 'oasis' (solo arena/montana/rio/portal) — esto coloca uno manual en el
-- bioma "Desierto" para poder ver oasis.png funcionando mientras esa mejora
-- del generador queda pendiente como tarea aparte. Revisar y ejecutar
-- manualmente en el SQL Editor de Supabase — no hay acceso de escritura a
-- la DB desde el agente (solo la anon key).
--
-- Posición relativa al spawn: (-2,-2) — dentro del radio 2 que
-- despejarRadio() ya garantiza como 'arena' (transitable) al generar el
-- terreno, y distinta de las posiciones que ya usa cofres_objetos.sql
-- (-1,-1 cofre; -2,0 y 0,-2 recurso madera), para no pisarlas.
with bioma_actual as (
  select id, tiles from public.biomas where nombre = 'Desierto' limit 1
),
spawn_calc as (
  select
    id,
    tiles,
    (tiles->'spawn'->>'x')::int as spawn_x,
    (tiles->'spawn'->>'y')::int as spawn_y
  from bioma_actual
),
tiles_modificados as (
  select
    s.id,
    jsonb_agg(
      case
        when (t.elem->>'x')::int = s.spawn_x - 2 and (t.elem->>'y')::int = s.spawn_y - 2
          then t.elem || jsonb_build_object('tipo', 'oasis')
        else t.elem
      end
      order by t.ordinality
    ) as nuevos_tiles
  from spawn_calc s
  cross join lateral jsonb_array_elements(s.tiles->'tiles') with ordinality as t(elem, ordinality)
  group by s.id
)
update public.biomas b
set tiles = jsonb_set(b.tiles, '{tiles}', tm.nuevos_tiles)
from tiles_modificados tm
where b.id = tm.id;

-- Verificación: debería devolver exactamente 1 fila con tipo "oasis". Si
-- devuelve 0, revisar que el bioma se llame exactamente 'Desierto' y que su
-- spawn tenga margen suficiente dentro del grid.
select tile
from public.biomas, jsonb_array_elements(tiles->'tiles') as tile
where nombre = 'Desierto'
  and tile->>'tipo' = 'oasis';
