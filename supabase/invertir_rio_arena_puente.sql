-- Invierte terreno en 5 casillas puntuales del Desierto:
-- (10,2), (9,2), (9,1) eran río -> pasan a arena.
-- (9,3), (8,3) eran arena -> pasan a río.
-- Verificado contra la base real antes de este cambio.
--
-- Revisar y ejecutar manualmente en el SQL Editor de Supabase.

with bioma as (
  select id, tiles from public.biomas where nombre = 'Desierto'
),
resueltos as (
  select
    bioma.id,
    jsonb_agg(
      case
        when (t.tile->>'x', t.tile->>'y') in (('10','2'), ('9','2'), ('9','1'))
          then t.tile || jsonb_build_object('tipo', 'arena')
        when (t.tile->>'x', t.tile->>'y') in (('9','3'), ('8','3'))
          then t.tile || jsonb_build_object('tipo', 'rio')
        else t.tile
      end
      order by t.ordinality
    ) as nuevos_tiles
  from bioma, jsonb_array_elements(bioma.tiles->'tiles') with ordinality as t(tile, ordinality)
  group by bioma.id
)
update public.biomas b
set tiles = jsonb_set(b.tiles, '{tiles}', r.nuevos_tiles)
from resueltos r
where b.id = r.id;

-- Verificación: las 5 casillas con su tipo correcto.
select tile->>'x' as x, tile->>'y' as y, tile->>'tipo' as tipo
from public.biomas, jsonb_array_elements(tiles->'tiles') as tile
where nombre = 'Desierto'
  and (tile->>'x', tile->>'y') in
    (('10','2'), ('9','2'), ('9','1'), ('9','3'), ('8','3'));
