-- Herramientas para recolectar piedra y lana, mismo patrón que Hacha/Madera
-- (ver cofres_objetos.sql) — data-driven vía objeto.efecto.recolecta, no
-- requiere tocar código. Revisar y ejecutar manualmente en el SQL Editor de
-- Supabase — no hay acceso de escritura a la DB desde el agente (solo la
-- anon key).

-- 1) Catálogo.
insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Pico', 'herramienta', jsonb_build_object('recolecta', 'piedra'), null
where not exists (select 1 from public.objetos where nombre = 'Pico');

insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Piedra', 'material', null, null
where not exists (select 1 from public.objetos where nombre = 'Piedra');

insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Tijeras', 'herramienta', jsonb_build_object('recolecta', 'lana'), null
where not exists (select 1 from public.objetos where nombre = 'Tijeras');

insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Lana', 'material', null, null
where not exists (select 1 from public.objetos where nombre = 'Lana');

-- 2) Dos cofres de prueba más (Pico y Tijeras) cerca del spawn del bioma
--    "Desierto", en los mismos offsets relativos seguros que ya usa
--    cofres_objetos.sql (radio 2 alrededor del spawn, que despejarRadio()
--    garantiza 'arena' al generar el terreno), en posiciones libres:
--    (-2,-1) para el Pico y (-1,-2) para las Tijeras — no pisan el cofre de
--    Hacha (-1,-1), las casillas de madera (-2,0 y 0,-2) ni el oasis (-2,-2).
with bioma_actual as (
  select id, tiles from public.biomas where nombre = 'Desierto' limit 1
),
spawn_calc as (
  select id, tiles, (tiles->'spawn'->>'x')::int as spawn_x, (tiles->'spawn'->>'y')::int as spawn_y
  from bioma_actual
),
objetos_ref as (
  select
    (select id from public.objetos where nombre = 'Pico' limit 1) as pico_id,
    (select id from public.objetos where nombre = 'Tijeras' limit 1) as tijeras_id
),
tiles_modificados as (
  select
    s.id,
    jsonb_agg(
      case
        when (t.elem->>'x')::int = s.spawn_x - 2 and (t.elem->>'y')::int = s.spawn_y - 1
          then t.elem || jsonb_build_object('cofre', jsonb_build_object('objetoId', o.pico_id, 'cantidad', 1))
        when (t.elem->>'x')::int = s.spawn_x - 1 and (t.elem->>'y')::int = s.spawn_y - 2
          then t.elem || jsonb_build_object('cofre', jsonb_build_object('objetoId', o.tijeras_id, 'cantidad', 1))
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

-- 3) Verificación: debería devolver 3 filas con "cofre" en total (Hacha +
--    Pico + Tijeras, si ya corriste cofres_objetos.sql antes). Si corriste
--    solo este archivo, deberían ser 2.
select tile
from public.biomas, jsonb_array_elements(tiles->'tiles') as tile
where nombre = 'Desierto'
  and tile ? 'cofre';
