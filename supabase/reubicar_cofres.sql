-- Reubica 3 de los 6 cofres del Desierto: quedaban demasiado juntos entre sí
-- (Cuerda/Banco de trabajo/Hacha, los tres pegados en la misma fila y a solo
-- 3-4 casillas de distancia). Poción, Pico y Tijeras no se tocan.
--
-- Nuevas posiciones (todas verificadas offline: arena libre y alcanzables a
-- pie desde el spawn con el mapa de mapa_desierto_final.sql):
--   Hacha:            (24,9)  -> (24,18)  (bien al sur de Tijeras, no pegado)
--   Banco de trabajo: (20,9)  -> (17,16)  (a la izquierda de Hacha, más separado)
--   Cuerda:           (17,9)  -> (10,14)  (a la izquierda de Banco, más separado)
--
-- Revisar y ejecutar manualmente en el SQL Editor de Supabase, después de
-- mapa_desierto_final.sql.

with bioma as (
  select id, tiles from public.biomas where nombre = 'Desierto'
),
resueltos as (
  select
    bioma.id,
    jsonb_agg(
      case
        -- Posiciones viejas: sacarles el cofre (vuelven a ser arena lisa).
        when (t.tile->>'x')::int = 24 and (t.tile->>'y')::int = 9 then (t.tile - 'cofre')
        when (t.tile->>'x')::int = 20 and (t.tile->>'y')::int = 9 then (t.tile - 'cofre')
        when (t.tile->>'x')::int = 17 and (t.tile->>'y')::int = 9 then (t.tile - 'cofre')
        -- Posiciones nuevas: les agrega el cofre correspondiente.
        when (t.tile->>'x')::int = 24 and (t.tile->>'y')::int = 18 then
          t.tile || jsonb_build_object('cofre', jsonb_build_object(
            'objetoId', (select id from public.objetos where nombre = 'Hacha' limit 1),
            'cantidad', 1
          ))
        when (t.tile->>'x')::int = 17 and (t.tile->>'y')::int = 16 then
          t.tile || jsonb_build_object('cofre', jsonb_build_object(
            'objetoId', (select id from public.objetos where nombre = 'Banco de trabajo' limit 1),
            'cantidad', 1
          ))
        when (t.tile->>'x')::int = 10 and (t.tile->>'y')::int = 14 then
          t.tile || jsonb_build_object('cofre', jsonb_build_object(
            'objetoId', (select id from public.objetos where nombre = 'Cuerda' limit 1),
            'cantidad', 1
          ))
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

update public.descubrimiento_jugador d
set cofres_abiertos = '[]'::jsonb
from public.biomas b
where b.id = d.bioma_id and b.nombre = 'Desierto';

-- Verificación: deberían aparecer exactamente 3 filas (24,18)/(17,16)/(10,14)
-- con 'cofre' resuelto (objetoId no nulo), y (24,9)/(20,9)/(17,9) sin 'cofre'.
select tile->>'x' as x, tile->>'y' as y, tile->'cofre' as cofre
from public.biomas, jsonb_array_elements(tiles->'tiles') as tile
where nombre = 'Desierto'
  and (tile->>'x', tile->>'y') in (('24','18'), ('17','16'), ('10','14'), ('24','9'), ('20','9'), ('17','9'));
