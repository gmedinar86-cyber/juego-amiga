-- Corrige RLS: varias tablas permitían UPDATE/DELETE/INSERT sin restricción
-- de propietario con la anon key. Revisar y ejecutar manualmente en el
-- SQL Editor de Supabase (dashboard > SQL Editor). No se aplica desde el
-- agente: cambios de seguridad se revisan antes de correr.
--
-- Tablas de solo lectura para el cliente: biomas, portales,
--   clases_personaje, objetos.
-- Tablas propiedad del jugador (dueño = usuario_id): descubrimiento_jugador,
--   progreso_jugador, vidas_bioma, inventario_jugador.

-- 1) Asegurar que RLS está activo en todas las tablas afectadas.
alter table public.biomas enable row level security;
alter table public.portales enable row level security;
alter table public.clases_personaje enable row level security;
alter table public.objetos enable row level security;
alter table public.descubrimiento_jugador enable row level security;
alter table public.progreso_jugador enable row level security;
alter table public.vidas_bioma enable row level security;
alter table public.inventario_jugador enable row level security;

-- 2) Eliminar cualquier policy previa (nombre desconocido y/o demasiado
--    permisiva) en estas tablas, para partir de cero.
do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'biomas', 'portales', 'clases_personaje', 'objetos',
        'descubrimiento_jugador', 'progreso_jugador',
        'vidas_bioma', 'inventario_jugador'
      )
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- 3) Tablas de solo lectura: SELECT para authenticated, sin policy de
--    insert/update/delete => esas operaciones quedan bloqueadas por defecto
--    para anon/authenticated (solo editables vía service_role, p.ej. panel admin).
create policy "biomas_select_authenticated"
  on public.biomas
  for select
  to authenticated
  using (true);

create policy "portales_select_authenticated"
  on public.portales
  for select
  to authenticated
  using (true);

create policy "clases_personaje_select_authenticated"
  on public.clases_personaje
  for select
  to authenticated
  using (true);

create policy "objetos_select_authenticated"
  on public.objetos
  for select
  to authenticated
  using (true);

-- 4) Tablas propiedad del jugador: select/insert/update/delete restringidos
--    a usuario_id = auth.uid().

create policy "progreso_select_own"
  on public.progreso_jugador
  for select
  to authenticated
  using (usuario_id = auth.uid());

create policy "progreso_insert_own"
  on public.progreso_jugador
  for insert
  to authenticated
  with check (usuario_id = auth.uid());

create policy "progreso_update_own"
  on public.progreso_jugador
  for update
  to authenticated
  using (usuario_id = auth.uid())
  with check (usuario_id = auth.uid());

-- Sin policy de delete: el juego no borra progreso todavía, queda
-- bloqueado por defecto hasta que haga falta de verdad.

create policy "descubrimiento_select_own"
  on public.descubrimiento_jugador
  for select
  to authenticated
  using (usuario_id = auth.uid());

create policy "descubrimiento_insert_own"
  on public.descubrimiento_jugador
  for insert
  to authenticated
  with check (usuario_id = auth.uid());

create policy "descubrimiento_update_own"
  on public.descubrimiento_jugador
  for update
  to authenticated
  using (usuario_id = auth.uid())
  with check (usuario_id = auth.uid());

-- Sin policy de delete: mismo criterio, bloqueado por defecto por ahora.

create policy "vidas_bioma_select_own"
  on public.vidas_bioma
  for select
  to authenticated
  using (usuario_id = auth.uid());

create policy "vidas_bioma_insert_own"
  on public.vidas_bioma
  for insert
  to authenticated
  with check (usuario_id = auth.uid());

create policy "vidas_bioma_update_own"
  on public.vidas_bioma
  for update
  to authenticated
  using (usuario_id = auth.uid())
  with check (usuario_id = auth.uid());

create policy "vidas_bioma_delete_own"
  on public.vidas_bioma
  for delete
  to authenticated
  using (usuario_id = auth.uid());

create policy "inventario_select_own"
  on public.inventario_jugador
  for select
  to authenticated
  using (usuario_id = auth.uid());

create policy "inventario_insert_own"
  on public.inventario_jugador
  for insert
  to authenticated
  with check (usuario_id = auth.uid());

create policy "inventario_update_own"
  on public.inventario_jugador
  for update
  to authenticated
  using (usuario_id = auth.uid())
  with check (usuario_id = auth.uid());

create policy "inventario_delete_own"
  on public.inventario_jugador
  for delete
  to authenticated
  using (usuario_id = auth.uid());

-- 5) Verificación rápida post-ejecución: debería listar todas las policies
--    de arriba, una fila por policy, con el "cmd" y el "qual"/"with_check"
--    esperado. Si alguna tabla no aparece aquí es que el nombre no coincide
--    con el schema real (revisar antes de dar por cerrado el hallazgo).
-- select schemaname, tablename, policyname, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
-- order by tablename, cmd;
