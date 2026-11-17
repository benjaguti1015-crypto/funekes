-- =====================================================================
--  FUNEKES · Esquema Supabase
--  Pegar completo en Supabase → SQL Editor → Run.  Es idempotente:
--  se puede volver a correr sin romper nada.
-- =====================================================================

create extension if not exists pgcrypto;

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
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists ticket_tiers_event_idx on public.ticket_tiers(event_id);

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
  paid_at      timestamptz
);
create index if not exists orders_event_idx  on public.orders(event_id);
create index if not exists orders_status_idx on public.orders(status);

create table if not exists public.tickets (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  first_name  text not null,
  last_name   text not null,
  email       text,                        -- ya no se pide (columna histórica)
  created_at  timestamptz not null default now()
);
create index if not exists tickets_order_idx on public.tickets(order_id);

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
  return new;
end;
$$;

drop trigger if exists orders_paid_at on public.orders;
create trigger orders_paid_at
  before update of status on public.orders
  for each row execute function public.orders_set_paid_at();

-- Entradas vendidas (no canceladas) por tramo. Uso interno: el público NO puede llamarla.
create or replace function public.tier_sold(p_tier_id uuid)
returns int
language sql stable security definer
set search_path = public
as $$
  select coalesce(sum(quantity), 0)::int
  from public.orders
  where tier_id = p_tier_id and status <> 'cancelado';
$$;

-- Crea una orden. El precio SIEMPRE se calcula acá, nunca en el navegador.
-- Venta escalonada: solo se vende el primer tramo activo con cupo disponible.
-- p_attendees: [{"first_name":"...","last_name":"..."}, ...]
create or replace function public.create_order(p_tier_id uuid, p_attendees jsonb)
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
    (code, event_id, tier_id, tier_name, buyer_name, quantity, unit_price, total)
  values
    (v_code, v_event.id, v_tier.id, v_tier.name,
     trim(p_attendees->0->>'first_name') || ' ' || trim(p_attendees->0->>'last_name'),
     v_qty, v_tier.price, v_tier.price * v_qty)
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

revoke all on function public.create_order(uuid, jsonb) from public;
grant execute on function public.create_order(uuid, jsonb) to anon, authenticated;
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

-- Permisos base (RLS decide qué filas). Explícitos por si el proyecto
-- no expone tablas nuevas automáticamente a la API.
grant usage on schema public to anon, authenticated;
grant select on public.events, public.ticket_tiers, public.settings to anon, authenticated;
grant insert, update, delete on public.events, public.ticket_tiers, public.settings to authenticated;
grant select, insert, update, delete on public.orders, public.tickets to authenticated;
grant select on public.admins to authenticated;

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
            where o.tier_id = t.id and o.status <> 'cancelado'
          ), 0) >= t.capacity) as sold_out,
         t.max_per_order
  from public.ticket_tiers t
  join public.events e on e.id = t.event_id
  where e.is_published;
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

insert into public.ticket_tiers (event_id, name, price, capacity, max_per_order, sort_order, is_active)
select e.id, t.name, t.price, t.capacity, t.max_per_order, t.sort_order, true
from public.events e
cross join (values ('Preventa 1', 4000, 10, 1, 1), ('Preventa 2', 5000, 100, 1, 2), ('Puerta', 6000, null, null, 3))
  as t(name, price, capacity, max_per_order, sort_order)
where e.slug = 'chao-clases-2026'
  and not exists (select 1 from public.ticket_tiers x where x.event_id = e.id);

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

-- ---------------------------------------------------------------------
-- 6. CREAR EL ADMIN (correr aparte, después de crear el usuario en
--    Authentication → Users → Add user)
-- ---------------------------------------------------------------------
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'CORREO_DEL_ADMIN'
-- on conflict do nothing;
