-- Agrega los 7 elementos que faltaban para poder completar el nivel:
-- ovejas (recurso 'lana') en (27,9) y (0,12); árboles (recurso 'madera')
-- en (22,2), (8,21), (6,11), (15,18) y (3,9).
--
-- Las 7 casillas ya estaban vacías (arena sin recurso ni cofre) antes de
-- este cambio — verificado contra la base real.
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
        when (t.tile->>'x', t.tile->>'y') in (('27','9'), ('0','12'))
          then t.tile || jsonb_build_object('recurso', 'lana')
        when (t.tile->>'x', t.tile->>'y') in (('22','2'), ('8','21'), ('6','11'), ('15','18'), ('3','9'))
          then t.tile || jsonb_build_object('recurso', 'madera')
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

-- Verificación: las 7 casillas con su recurso correcto.
select tile->>'x' as x, tile->>'y' as y, tile->>'tipo' as tipo, tile->>'recurso' as recurso
from public.biomas, jsonb_array_elements(tiles->'tiles') as tile
where nombre = 'Desierto'
  and (tile->>'x', tile->>'y') in
    (('27','9'), ('0','12'), ('22','2'), ('8','21'), ('6','11'), ('15','18'), ('3','9'));
