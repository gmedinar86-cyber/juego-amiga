-- Cofres + recolección con requisito de herramienta. Revisar y ejecutar
-- manualmente en el SQL Editor de Supabase — no hay acceso de escritura a
-- la DB desde el agente (solo la anon key), así que este paso siempre lo
-- corrés vos.

-- 1) Catálogo: primer par herramienta/material para probar la cadena
--    completa. `efecto.recolecta` en la herramienta indica qué tipo de
--    recurso habilita — el cliente lo lee de forma genérica (lib/objetos.ts),
--    así que agregar más pares en el futuro no requiere tocar código, solo
--    insertar más filas acá.
insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Hacha', 'herramienta', jsonb_build_object('recolecta', 'madera'), null
where not exists (select 1 from public.objetos where nombre = 'Hacha');

insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Madera', 'material', null, null
where not exists (select 1 from public.objetos where nombre = 'Madera');

-- 2) Estado por-jugador de cofres abiertos / recursos ya recolectados.
--    Mismo lugar que `casillas_descubiertas`: descubrimiento_jugador ya es
--    "estado por-jugador, por-bioma" de qué casillas ya interactuaste — no
--    hace falta una tabla nueva ni políticas RLS nuevas (las de UPDATE que
--    ya existen sobre esta tabla cubren las columnas nuevas automáticamente).
alter table public.descubrimiento_jugador
  add column if not exists cofres_abiertos jsonb not null default '[]'::jsonb;
alter table public.descubrimiento_jugador
  add column if not exists recursos_recolectados jsonb not null default '[]'::jsonb;

-- 3) Coloca un cofre de prueba (con el hacha) y dos casillas de recurso
--    madera en el bioma "Desierto", cerca del spawn. Se usan posiciones
--    relativas al spawn (no coordenadas fijas) porque despejarRadio() ya
--    garantiza que un radio de 2 alrededor del spawn es 'arena' (transitable)
--    al generar el terreno — son seguras sin importar el tamaño del bioma,
--    siempre que el bioma tenga al menos ~3 casillas de margen (n >= 3).
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
objetos_ref as (
  select (select id from public.objetos where nombre = 'Hacha' limit 1) as hacha_id
),
tiles_modificados as (
  select
    s.id,
    jsonb_agg(
      case
        when (t.elem->>'x')::int = s.spawn_x - 1 and (t.elem->>'y')::int = s.spawn_y - 1
          then t.elem || jsonb_build_object('cofre', jsonb_build_object('objetoId', o.hacha_id, 'cantidad', 1))
        when (t.elem->>'x')::int = s.spawn_x - 2 and (t.elem->>'y')::int = s.spawn_y
          then t.elem || jsonb_build_object('recurso', 'madera')
        when (t.elem->>'x')::int = s.spawn_x and (t.elem->>'y')::int = s.spawn_y - 2
          then t.elem || jsonb_build_object('recurso', 'madera')
        else t.elem
      end
      order by t.ordinality
    ) as nuevos_tiles
  from spawn_calc s
  cross join objetos_ref o
  cross join lateral jsonb_array_elements(s.tiles->'tiles') with ordinality as t(elem, ordinality)
  group by s.id
)
update public.biomas b
set tiles = jsonb_set(b.tiles, '{tiles}', tm.nuevos_tiles)
from tiles_modificados tm
where b.id = tm.id;

-- 4) Verificación: debería devolver 3 filas (1 con "cofre", 2 con
--    recurso "madera"). Si devuelve menos, revisar que el bioma se llame
--    exactamente 'Desierto' y que su spawn tenga margen suficiente dentro
--    del grid para las posiciones relativas usadas arriba.
select tile
from public.biomas, jsonb_array_elements(tiles->'tiles') as tile
where nombre = 'Desierto'
  and (tile ? 'cofre' or tile->>'recurso' = 'madera');
