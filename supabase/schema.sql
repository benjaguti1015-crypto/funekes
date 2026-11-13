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
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists ticket_tiers_event_idx on public.ticket_tiers(event_id);

create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  event_id     uuid not null references public.events(id) on delete restrict,
  tier_id      uuid not null references public.ticket_tiers(id) on delete restrict,
  tier_name    text not null,              -- copia histórica
  buyer_name   text not null,
  buyer_email  text not null,
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
  email       text not null,
  created_at  timestamptz not null default now()
);
create index if not exists tickets_order_idx on public.tickets(order_id);

-- Una sola fila con los datos de transferencia y contacto
create table if not exists public.settings (
  id              int primary key default 1 check (id = 1),
  bank_name       text,
  account_type    text,
  account_number  text,
  holder_name     text,
  holder_rut      text,
  transfer_email  text,
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

-- Entradas vendidas (no canceladas) por tramo, visible para el público
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
-- p_attendees: [{"first_name":"...","last_name":"...","email":"..."}, ...]
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

  if v_tier.capacity is not null then
    v_sold := public.tier_sold(v_tier.id);
    if v_sold + v_qty > v_tier.capacity then
      raise exception 'Quedan % entradas en %', greatest(v_tier.capacity - v_sold, 0), v_tier.name;
    end if;
  end if;

  for v_a in select * from jsonb_array_elements(p_attendees) loop
    if coalesce(trim(v_a->>'first_name'), '') = ''
       or coalesce(trim(v_a->>'last_name'), '') = '' then
      raise exception 'Cada entrada necesita nombre y apellido';
    end if;
    if coalesce(v_a->>'email', '') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Correo inválido: %', coalesce(v_a->>'email', '(vacío)');
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
    (code, event_id, tier_id, tier_name, buyer_name, buyer_email, quantity, unit_price, total)
  values
    (v_code, v_event.id, v_tier.id, v_tier.name,
     trim(p_attendees->0->>'first_name') || ' ' || trim(p_attendees->0->>'last_name'),
     lower(trim(p_attendees->0->>'email')),
     v_qty, v_tier.price, v_tier.price * v_qty)
  returning id into v_order;

  insert into public.tickets (order_id, first_name, last_name, email)
  select v_order, trim(a->>'first_name'), trim(a->>'last_name'), lower(trim(a->>'email'))
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
grant execute on function public.tier_sold(uuid)            to anon, authenticated;
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

-- ticket_tiers
drop policy if exists tiers_public_read on public.ticket_tiers;
create policy tiers_public_read on public.ticket_tiers
  for select using (
    public.is_admin() or exists (
      select 1 from public.events e where e.id = event_id and e.is_published
    )
  );
drop policy if exists tiers_admin_all on public.ticket_tiers;
create policy tiers_admin_all on public.ticket_tiers
  for all using (public.is_admin()) with check (public.is_admin());

-- orders / tickets: solo admins (el público crea vía create_order)
drop policy if exists orders_admin_all on public.orders;
create policy orders_admin_all on public.orders
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists tickets_admin_all on public.tickets;
create policy tickets_admin_all on public.tickets
  for all using (public.is_admin()) with check (public.is_admin());

-- settings: lectura pública (datos de transferencia), edición admin
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

insert into public.settings (id, bank_name, account_type, account_number, holder_name, holder_rut, transfer_email, whatsapp, instagram)
values (1, 'Banco Estado', 'Cuenta RUT', '12345678', 'Funekes Producciones', '12.345.678-9',
        'entradas@funekes.cl', '+56900000000', '99funekes')
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

insert into public.ticket_tiers (event_id, name, price, sort_order, is_active)
select e.id, t.name, t.price, t.sort_order, true
from public.events e
cross join (values ('Preventa 1', 4000, 1), ('Preventa 2', 5000, 2), ('General', 7000, 3))
  as t(name, price, sort_order)
where e.slug = 'chao-clases-2026'
  and not exists (select 1 from public.ticket_tiers x where x.event_id = e.id);

-- ---------------------------------------------------------------------
-- 6. CREAR EL ADMIN (correr aparte, después de crear el usuario en
--    Authentication → Users → Add user)
-- ---------------------------------------------------------------------
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'CORREO_DEL_ADMIN'
-- on conflict do nothing;
