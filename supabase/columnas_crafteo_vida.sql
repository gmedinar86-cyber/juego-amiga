-- Esquema para: banco de trabajo + crafteo, herramientas con durabilidad,
-- puentes, cuerdas y sistema de vida. Revisar y ejecutar manualmente en el
-- SQL Editor de Supabase — no hay acceso de escritura a la DB desde el
-- agente (solo la anon key). Correr ANTES que mapa_desierto_fijo.sql.

-- 1) Vida del jugador: arranca en 10 y el tope de este sistema (cactus, etc.)
--    también es 10, fijo en el cliente — independiente de la columna
--    preexistente progreso_jugador.vida_maxima (ya tiene otro valor por
--    defecto para otros fines, no se toca acá).
alter table public.progreso_jugador
  add column if not exists vida_actual integer not null default 10;

-- 2) Durabilidad de herramientas: solo se completa para instancias de
--    Hacha/Pico (10 usos al craftear/obtener de cofre). El resto de items
--    (materiales, Tijeras, Banco de trabajo, Cuerda, Poción) la dejan en
--    null.
alter table public.inventario_jugador
  add column if not exists usos_restantes integer null;

-- 3) Puentes y cuerdas construidos por cada jugador (estado por-jugador,
--    por-bioma — mismo lugar que cofres_abiertos/recursos_recolectados).
alter table public.descubrimiento_jugador
  add column if not exists puentes_construidos jsonb not null default '[]'::jsonb;
alter table public.descubrimiento_jugador
  add column if not exists cuerdas_construidas jsonb not null default '[]'::jsonb;

-- 4) Catálogo nuevo. Banco de trabajo no se rompe (sin usos_restantes) y
--    habilita crafteo con solo tenerlo en el inventario. Cuerda se craftea
--    como Hacha/Pico/Tijeras pero se consume entera (delete de la fila) al
--    colocarse junto a una montaña, no tiene durabilidad por uso. Poción
--    todavía no tiene efecto definido, solo ocupa un slot de inventario.
insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Banco de trabajo', 'herramienta', null, null
where not exists (select 1 from public.objetos where nombre = 'Banco de trabajo');

insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Cuerda', 'herramienta', null, null
where not exists (select 1 from public.objetos where nombre = 'Cuerda');

insert into public.objetos (nombre, tipo, efecto, bioma_id)
select 'Poción', 'material', null, null
where not exists (select 1 from public.objetos where nombre = 'Poción');

-- 5) Verificación: debería listar 3 filas (Banco de trabajo, Cuerda, Poción).
select nombre, tipo, efecto from public.objetos
where nombre in ('Banco de trabajo', 'Cuerda', 'Poción');
