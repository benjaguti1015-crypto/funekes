-- =====================================================================
--  FUNEKES · Esquema Supabase
--  Pegar completo en Supabase → SQL Editor → Run.  Es idempotente:
--  se puede volver a correr sin romper nada.
-- =====================================================================

create extension if not exists pgcrypto;

-- Código único de cada entrada (va dentro del QR), ej. K7QM-2XPA-9HTD.
-- 12 caracteres al azar (60 bits) sin letras confusas (0/O, 1/I).
create or replace function public.gen_ticket_code()
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_code  text := '';
  i       int;
begin
  -- solo los bytes 100 % aleatorios del UUID v4
  foreach i in array array[0,1,2,3,4,5,10,11,12,13,14,15] loop
    v_code := v_code || substr(v_alpha, 1 + get_byte(v_bytes, i) % 32, 1);
  end loop;
  return substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4);
end;
$$;

-- ---------------------------------------------------------------------
-- 1. TABLAS
-- ---------------------------------------------------------------------

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  title         text not null,
  subtitle      text,
  format_label  text default 'Formato discoteca',
  starts_at     timestamptz not null,
  location      text not null default 'Tomé, Biobío',
  venue         text default 'Recinto y horario por anunciar',
  cover_url     text,             -- foto/afiche del próximo evento
  poster_url    text,             -- afiche (archivo)
  recap_url     text,             -- imagen de cierre (archivo)
  attendance    int,              -- asistentes (archivo)
  recap_text    text,             -- texto corto (archivo)
  is_published  boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.ticket_tiers (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  name        text not null,
  price       int  not null check (price >= 0),          -- CLP
  capacity    int  check (capacity is null or capacity > 0), -- null = sin límite
  max_per_order int check (max_per_order is null or max_per_order between 1 and 10), -- null = 10
  door_only   boolean not null default false,            -- solo en puerta (efectivo): no se vende en la web
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists ticket_tiers_event_idx on public.ticket_tiers(event_id);

-- Migración de tramos para instalaciones anteriores (Preventa 1/2 sin cupo y
-- "General $7.000"). Solo toca los valores originales: si ya los editaste en el
-- panel, no los pisa.
update public.ticket_tiers t set capacity = 10
from public.events e
where e.id = t.event_id and e.slug = 'chao-clases-2026'
  and t.name = 'Preventa 1' and t.capacity is null;
update public.ticket_tiers t set capacity = 100
from public.events e
where e.id = t.event_id and e.slug = 'chao-clases-2026'
  and t.name = 'Preventa 2' and t.capacity is null;
update public.ticket_tiers t set name = 'Puerta', price = 6000
from public.events e
where e.id = t.event_id and e.slug = 'chao-clases-2026'
  and t.name = 'General' and t.price = 7000;

-- Migración: máximo de entradas por compra. Al agregarla por primera vez deja
-- las preventas en 1 por persona; después manda lo que diga el panel.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ticket_tiers' and column_name = 'max_per_order'
  ) then
    alter table public.ticket_tiers
      add column max_per_order int check (max_per_order is null or max_per_order between 1 and 10);
    update public.ticket_tiers set max_per_order = 1 where name ilike 'preventa%';
  end if;
end $$;

-- Migración: tramo solo en puerta. Al agregarla por primera vez marca "Puerta".
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ticket_tiers' and column_name = 'door_only'
  ) then
    alter table public.ticket_tiers add column door_only boolean not null default false;
    update public.ticket_tiers set door_only = true where name ilike 'puerta%';
  end if;
end $$;

create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  event_id     uuid not null references public.events(id) on delete restrict,
  tier_id      uuid not null references public.ticket_tiers(id) on delete restrict,
  tier_name    text not null,              -- copia histórica
  buyer_name   text not null,
  buyer_email  text,                       -- ya no se pide (columna histórica)
  quantity     int  not null check (quantity between 1 and 10),
  unit_price   int  not null,
  total        int  not null,
  status       text not null default 'pendiente'
               check (status in ('pendiente','pagado','cancelado')),
  notes        text,
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  terms_accepted_at timestamptz,            -- cuándo aceptó términos y privacidad
  expires_at   timestamptz default (now() + interval '24 hours') -- una orden pendiente reserva cupo hasta acá
);
create index if not exists orders_event_idx  on public.orders(event_id);
create index if not exists orders_status_idx on public.orders(status);

create table if not exists public.tickets (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  first_name  text not null,
  last_name   text not null,
  email       text,                        -- ya no se pide (columna histórica)
  qr_code     text not null default public.gen_ticket_code(), -- lo que lleva el QR
  checked_in_at timestamptz,               -- hora de ingreso (null = no ha entrado)
  checked_in_by uuid,                      -- quién lo escaneó
  created_at  timestamptz not null default now()
);
create index if not exists tickets_order_idx on public.tickets(order_id);

-- Migración: QR e ingreso (cada entrada que ya existía recibe su propio código)
alter table public.tickets add column if not exists qr_code text not null default public.gen_ticket_code();
alter table public.tickets add column if not exists checked_in_at timestamptz;
alter table public.tickets add column if not exists checked_in_by uuid;
create unique index if not exists tickets_qr_code_key on public.tickets(qr_code);

-- Migración: registro de la aceptación de términos y privacidad
alter table public.orders add column if not exists terms_accepted_at timestamptz;

-- Migración: las órdenes pendientes vencen a las 24 horas.
-- Las que ya existían reciben 24 horas desde este momento.
alter table public.orders add column if not exists expires_at timestamptz default (now() + interval '24 hours');

-- Migración: solo se pide nombre y apellido (instalaciones anteriores pedían correo)
alter table public.orders  alter column buyer_email drop not null;
alter table public.tickets alter column email       drop not null;

-- Una sola fila con el contacto. Los datos de transferencia NO van en la web:
-- el dueño se los pasa al comprador por WhatsApp.
create table if not exists public.settings (
  id              int primary key default 1 check (id = 1),
  whatsapp        text,
  instagram       text,
  updated_at      timestamptz not null default now()
);

create table if not exists public.admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Guardias: solo pueden escanear entradas en puerta.html. No ven ventas ni precios.
create table if not exists public.guards (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. FUNCIONES
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Admin o guardia
create or replace function public.is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
      or exists (select 1 from public.guards where user_id = auth.uid());
$$;

-- 'admin' | 'guard' | null
create or replace function public.staff_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.admins where user_id = auth.uid()) then 'admin'
    when exists (select 1 from public.guards where user_id = auth.uid()) then 'guard'
  end;
$$;

-- paid_at se completa / limpia solo
create or replace function public.orders_set_paid_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'pagado' and (old.status is distinct from 'pagado') then
    new.paid_at := now();
  elsif new.status <> 'pagado' then
    new.paid_at := null;
  end if;
  -- al reactivar una orden (vuelve a pendiente) parte un plazo nuevo de 24 horas
  if new.status = 'pendiente' and (old.status is distinct from 'pendiente') then
    new.expires_at := now() + interval '24 hours';
    if new.notes like 'Venció:%' then
      new.notes := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_paid_at on public.orders;
create trigger orders_paid_at
  before update of status on public.orders
  for each row execute function public.orders_set_paid_at();

-- Entradas que ocupan cupo en un tramo: las pagadas y las pendientes que aún no vencen.
-- Uso interno: el público NO puede llamarla.
create or replace function public.tier_sold(p_tier_id uuid)
returns int
language sql stable security definer
set search_path = public
as $$
  select coalesce(sum(quantity), 0)::int
  from public.orders
  where tier_id = p_tier_id
    and (status = 'pagado' or (status = 'pendiente' and coalesce(expires_at, 'infinity') > now()));
$$;

-- Cancela las órdenes pendientes que llevan más de 24 horas sin pago y libera su cupo.
-- No hay tarea programada: se ejecuta sola en cada compra y cada vez que el admin abre el panel.
create or replace function public.expire_pending_orders()
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update public.orders
     set status = 'cancelado',
         notes  = 'Venció: pasaron 24 horas sin pago'
   where status = 'pendiente'
     and expires_at is not null
     and expires_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Crea una orden. El precio SIEMPRE se calcula acá, nunca en el navegador.
-- Venta escalonada: solo se vende el primer tramo activo con cupo disponible.
-- p_attendees: [{"first_name":"...","last_name":"..."}, ...]
-- p_accepted:  el comprador marcó "acepto los términos y la política de privacidad"
drop function if exists public.create_order(uuid, jsonb);
create or replace function public.create_order(p_tier_id uuid, p_attendees jsonb, p_accepted boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_tier   public.ticket_tiers%rowtype;
  v_event  public.events%rowtype;
  v_qty    int;
  v_sold   int;
  v_code   text;
  v_order  uuid;
  v_a      jsonb;
  v_alpha  constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i        int;
begin
  if not coalesce(p_accepted, false) then
    raise exception 'Para comprar tienes que aceptar los Términos y condiciones y la Política de privacidad';
  end if;
  -- libera el cupo de las reservas vencidas antes de contar
  perform public.expire_pending_orders();
  if p_attendees is null or jsonb_typeof(p_attendees) <> 'array' then
    raise exception 'Faltan los datos de los asistentes';
  end if;

  v_qty := jsonb_array_length(p_attendees);
  if v_qty < 1 or v_qty > 10 then
    raise exception 'Puedes comprar entre 1 y 10 entradas por orden';
  end if;

  -- bloquea el tramo para evitar sobreventa
  select * into v_tier from public.ticket_tiers where id = p_tier_id for update;
  if not found or not v_tier.is_active then
    raise exception 'Este tramo de entradas no está disponible';
  end if;
  if v_tier.door_only then
    raise exception '% se vende solo en la entrada del evento, en efectivo', v_tier.name;
  end if;

  select * into v_event from public.events where id = v_tier.event_id;
  if not v_event.is_published or v_event.starts_at < now() - interval '12 hours' then
    raise exception 'La venta para este evento está cerrada';
  end if;

  if v_qty > coalesce(v_tier.max_per_order, 10) then
    if v_tier.max_per_order = 1 then
      raise exception '% es 1 entrada por persona', v_tier.name;
    end if;
    raise exception 'En % puedes comprar hasta % entradas por orden', v_tier.name, v_tier.max_per_order;
  end if;

  -- venta escalonada: un tramo se abre recién cuando se agotan los anteriores
  if exists (
    select 1 from public.ticket_tiers p
    where p.event_id = v_tier.event_id
      and p.is_active
      and not p.door_only
      and p.sort_order < v_tier.sort_order
      and (p.capacity is null or public.tier_sold(p.id) < p.capacity)
  ) then
    raise exception '% todavía no está a la venta', v_tier.name;
  end if;

  -- el mensaje nunca revela cuántas entradas quedan
  if v_tier.capacity is not null then
    v_sold := public.tier_sold(v_tier.id);
    if v_sold >= v_tier.capacity then
      raise exception '% se agotó', v_tier.name;
    elsif v_sold + v_qty > v_tier.capacity then
      raise exception 'No quedan suficientes entradas en % para esa cantidad. Prueba con menos.', v_tier.name;
    end if;
  end if;

  for v_a in select * from jsonb_array_elements(p_attendees) loop
    if coalesce(trim(v_a->>'first_name'), '') = ''
       or coalesce(trim(v_a->>'last_name'), '') = '' then
      raise exception 'Cada entrada necesita nombre y apellido';
    end if;
    if length(trim(v_a->>'first_name')) > 60 or length(trim(v_a->>'last_name')) > 60 then
      raise exception 'El nombre y el apellido pueden tener hasta 60 caracteres cada uno';
    end if;
  end loop;

  -- código corto y único, ej. FNK-7Q2KX
  loop
    v_code := 'FNK-';
    for i in 1..5 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from public.orders where code = v_code);
  end loop;

  insert into public.orders
    (code, event_id, tier_id, tier_name, buyer_name, quantity, unit_price, total, terms_accepted_at)
  values
    (v_code, v_event.id, v_tier.id, v_tier.name,
     trim(p_attendees->0->>'first_name') || ' ' || trim(p_attendees->0->>'last_name'),
     v_qty, v_tier.price, v_tier.price * v_qty, now())
  returning id into v_order;

  insert into public.tickets (order_id, first_name, last_name)
  select v_order, trim(a->>'first_name'), trim(a->>'last_name')
  from jsonb_array_elements(p_attendees) a;

  return jsonb_build_object(
    'code',        v_code,
    'event_title', v_event.title,
    'tier_name',   v_tier.name,
    'quantity',    v_qty,
    'unit_price',  v_tier.price,
    'total',       v_tier.price * v_qty
  );
end;
$$;

-- Escaneo en puerta. Solo admin o guardia. Marca el ingreso una sola vez.
-- Devuelve {result: ok | used | unpaid | cancelled | wrong_event | not_found, ...}
create or replace function public.check_in(p_code text, p_event_id uuid default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_t    record;
  v_info jsonb;
begin
  if not public.is_staff() then
    raise exception 'No autorizado';
  end if;
  if length(v_code) <> 12 then
    return jsonb_build_object('result', 'not_found');
  end if;
  v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4);

  -- bloquea la entrada: dos escaneos simultáneos no pueden entrar los dos
  select t.id, t.first_name, t.last_name, t.checked_in_at,
         o.status, o.tier_name, o.event_id, e.title as event_title
    into v_t
  from public.tickets t
  join public.orders o on o.id = t.order_id
  join public.events e on e.id = o.event_id
  where t.qr_code = v_code
  for update of t;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_info := jsonb_build_object(
    'name', v_t.first_name || ' ' || v_t.last_name,
    'tier_name', v_t.tier_name,
    'event_title', v_t.event_title
  );

  if p_event_id is not null and v_t.event_id <> p_event_id then
    return v_info || jsonb_build_object('result', 'wrong_event');
  elsif v_t.status = 'cancelado' then
    return v_info || jsonb_build_object('result', 'cancelled');
  elsif v_t.status <> 'pagado' then
    return v_info || jsonb_build_object('result', 'unpaid');
  elsif v_t.checked_in_at is not null then
    return v_info || jsonb_build_object('result', 'used', 'checked_in_at', v_t.checked_in_at);
  end if;

  update public.tickets
     set checked_in_at = now(), checked_in_by = auth.uid()
   where id = v_t.id;

  return v_info || jsonb_build_object('result', 'ok', 'checked_in_at', now());
end;
$$;

-- Cuántas personas han ingresado a un evento (para la pantalla del guardia)
create or replace function public.door_count(p_event_id uuid)
returns int
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'No autorizado';
  end if;
  return (
    select count(*)::int
    from public.tickets t
    join public.orders o on o.id = t.order_id
    where o.event_id = p_event_id and t.checked_in_at is not null
  );
end;
$$;

-- Traspaso: cambia el nombre de una entrada y le da un QR nuevo
-- (el QR anterior deja de servir). Solo admin.
create or replace function public.transfer_ticket(p_ticket_id uuid, p_first_name text, p_last_name text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_t   public.tickets%rowtype;
  v_qty int;
begin
  if not public.is_admin() then
    raise exception 'No autorizado';
  end if;
  if coalesce(trim(p_first_name), '') = '' or coalesce(trim(p_last_name), '') = '' then
    raise exception 'Faltan el nombre y el apellido de quien recibe la entrada';
  end if;
  if length(trim(p_first_name)) > 60 or length(trim(p_last_name)) > 60 then
    raise exception 'El nombre y el apellido pueden tener hasta 60 caracteres cada uno';
  end if;

  select * into v_t from public.tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'La entrada no existe';
  end if;
  if v_t.checked_in_at is not null then
    raise exception 'Esta entrada ya se usó para ingresar';
  end if;

  update public.tickets
     set first_name = trim(p_first_name), last_name = trim(p_last_name),
         qr_code = public.gen_ticket_code()
   where id = p_ticket_id
  returning * into v_t;

  -- si la orden es de una sola entrada, el comprador pasa a ser la persona nueva
  select quantity into v_qty from public.orders where id = v_t.order_id;
  if v_qty = 1 then
    update public.orders set buyer_name = v_t.first_name || ' ' || v_t.last_name where id = v_t.order_id;
  end if;

  return to_jsonb(v_t);
end;
$$;

revoke all on function public.check_in(text, uuid)               from public, anon;
revoke all on function public.door_count(uuid)                   from public, anon;
revoke all on function public.transfer_ticket(uuid, text, text)  from public, anon;
grant execute on function public.check_in(text, uuid)              to authenticated;
grant execute on function public.door_count(uuid)                  to authenticated;
grant execute on function public.transfer_ticket(uuid, text, text) to authenticated;
grant execute on function public.is_staff()                        to anon, authenticated;
grant execute on function public.staff_role()                      to anon, authenticated;

revoke all on function public.expire_pending_orders() from public, anon;
grant execute on function public.expire_pending_orders() to authenticated;
revoke all on function public.create_order(uuid, jsonb, boolean) from public;
grant execute on function public.create_order(uuid, jsonb, boolean) to anon, authenticated;
revoke all on function public.tier_sold(uuid) from public, anon, authenticated;
grant execute on function public.is_admin()                 to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. SEGURIDAD (RLS)
-- ---------------------------------------------------------------------

alter table public.events       enable row level security;
alter table public.ticket_tiers enable row level security;
alter table public.orders       enable row level security;
alter table public.tickets      enable row level security;
alter table public.settings     enable row level security;
alter table public.admins       enable row level security;
alter table public.guards       enable row level security;

-- Permisos base (RLS decide qué filas). Explícitos por si el proyecto
-- no expone tablas nuevas automáticamente a la API.
grant usage on schema public to anon, authenticated;
grant select on public.events, public.ticket_tiers, public.settings to anon, authenticated;
grant insert, update, delete on public.events, public.ticket_tiers, public.settings to authenticated;
grant select, insert, update, delete on public.orders, public.tickets to authenticated;
grant select on public.admins, public.guards to authenticated;

-- events
drop policy if exists events_public_read on public.events;
create policy events_public_read on public.events
  for select using (is_published or public.is_admin());
drop policy if exists events_admin_all on public.events;
create policy events_admin_all on public.events
  for all using (public.is_admin()) with check (public.is_admin());

-- ticket_tiers: solo admins. La tabla tiene el cupo, que el público no debe ver;
-- la web lee la vista tiers_public (sin cupo ni vendidas, solo "agotado sí/no").
drop policy if exists tiers_public_read on public.ticket_tiers;
drop policy if exists tiers_admin_all on public.ticket_tiers;
create policy tiers_admin_all on public.ticket_tiers
  for all using (public.is_admin()) with check (public.is_admin());

create or replace view public.tiers_public
with (security_invoker = false) as
  select t.id, t.event_id, t.name, t.price, t.sort_order, t.is_active,
         (t.capacity is not null and coalesce((
            select sum(o.quantity) from public.orders o
            where o.tier_id = t.id
              and (o.status = 'pagado' or (o.status = 'pendiente' and coalesce(o.expires_at, 'infinity') > now()))
          ), 0) >= t.capacity) as sold_out,
         t.max_per_order,
         t.door_only
  from public.ticket_tiers t
  join public.events e on e.id = t.event_id
  where e.is_published;
-- solo lectura: Supabase da todos los permisos por defecto a los objetos nuevos
revoke all on public.tiers_public from anon, authenticated;
grant select on public.tiers_public to anon, authenticated;

-- orders / tickets: solo admins (el público crea vía create_order)
drop policy if exists orders_admin_all on public.orders;
create policy orders_admin_all on public.orders
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists tickets_admin_all on public.tickets;
create policy tickets_admin_all on public.tickets
  for all using (public.is_admin()) with check (public.is_admin());

-- settings: lectura pública (contacto), edición admin
drop policy if exists settings_public_read on public.settings;
create policy settings_public_read on public.settings for select using (true);
drop policy if exists settings_admin_write on public.settings;
create policy settings_admin_write on public.settings
  for all using (public.is_admin()) with check (public.is_admin());

-- admins: cada usuario solo ve su propia fila
drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins
  for select using (user_id = auth.uid());

-- guards: igual
drop policy if exists guards_self_read on public.guards;
create policy guards_self_read on public.guards
  for select using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 4. STORAGE (imágenes de eventos)
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('event-media', 'event-media', true)
on conflict (id) do nothing;

drop policy if exists event_media_public_read on storage.objects;
create policy event_media_public_read on storage.objects
  for select using (bucket_id = 'event-media');
drop policy if exists event_media_admin_insert on storage.objects;
create policy event_media_admin_insert on storage.objects
  for insert with check (bucket_id = 'event-media' and public.is_admin());
drop policy if exists event_media_admin_update on storage.objects;
create policy event_media_admin_update on storage.objects
  for update using (bucket_id = 'event-media' and public.is_admin());
drop policy if exists event_media_admin_delete on storage.objects;
create policy event_media_admin_delete on storage.objects
  for delete using (bucket_id = 'event-media' and public.is_admin());

-- ---------------------------------------------------------------------
-- 5. DATOS INICIALES (demo)
-- ---------------------------------------------------------------------

insert into public.settings (id, whatsapp, instagram)
values (1, '+56959897604', '99funekes')
on conflict (id) do nothing;

insert into public.events (slug, title, subtitle, format_label, starts_at, location, venue, cover_url)
values ('chao-clases-2026', 'Chao Clases 2026',
        'Una noche con DJs para despedir el año de clases.',
        'Formato discoteca', '2026-12-12 23:00:00-03', 'Tomé, Biobío',
        'Recinto y horario por anunciar', null)
on conflict (slug) do nothing;

insert into public.events (slug, title, subtitle, format_label, starts_at, location, venue,
                           poster_url, recap_url, attendance, recap_text)
values ('halloween-funekes-2026', 'Halloween Funekes', null, 'Formato discoteca',
        '2026-10-31 21:00:00-03', 'Tomé, Biobío', 'Círculo Naval, Sotomayor 820',
        'assets/img/halloween-afiche.jpg', 'assets/img/halloween-gracias.jpg', 500,
        'Disfraces, reggaetón y una pista llena. Gracias a todos los que llenaron el Círculo Naval.')
on conflict (slug) do nothing;

insert into public.ticket_tiers (event_id, name, price, capacity, max_per_order, door_only, sort_order, is_active)
select e.id, t.name, t.price, t.capacity, t.max_per_order, t.door_only, t.sort_order, t.is_active
from public.events e
-- Preventa 2 parte cerrada: el admin la abre cuando quiera (no se abre sola al agotarse la 1)
cross join (values ('Preventa 1', 4000, 10, 1, false, 1, true), ('Preventa 2', 5000, 100, 1, false, 2, false), ('Puerta', 6000, null, null, true, 3, true))
  as t(name, price, capacity, max_per_order, door_only, sort_order, is_active)
where e.slug = 'chao-clases-2026'
  and not exists (select 1 from public.ticket_tiers x where x.event_id = e.id);

-- ---------------------------------------------------------------------
-- 6. CREAR EL ADMIN (correr aparte, después de crear el usuario en
--    Authentication → Users → Add user)
-- ---------------------------------------------------------------------
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'CORREO_DEL_ADMIN'
-- on conflict do nothing;

-- ---------------------------------------------------------------------
-- 7. CREAR EL GUARDIA (igual: primero créale un usuario en
--    Authentication → Users → Add user, con correo y contraseña)
--    Entra en /puerta.html y solo puede escanear.
-- ---------------------------------------------------------------------
-- insert into public.guards (user_id)
-- select id from auth.users where email = 'CORREO_DEL_GUARDIA'
-- on conflict do nothing;
