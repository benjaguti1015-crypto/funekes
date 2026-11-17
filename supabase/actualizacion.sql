-- =====================================================================
--  FUNEKES · Actualización corta
--  Para una base que YA tiene schema.sql pegado. Agrega:
--    1. registro de la aceptación de términos en cada orden
--    2. vencimiento de las órdenes pendientes a las 24 horas
--    3. máximo de 60 caracteres en nombre y apellido
--  Pegar completo en Supabase → SQL Editor → Run. Se puede correr más de una vez.
--  (schema.sql ya incluye todo esto: si pegas ese, no necesitas este.)
-- =====================================================================

alter table public.orders add column if not exists terms_accepted_at timestamptz;
alter table public.orders add column if not exists expires_at timestamptz default (now() + interval '24 hours');

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

revoke all on function public.tier_sold(uuid) from public, anon, authenticated;
revoke all on function public.expire_pending_orders() from public, anon;
grant execute on function public.expire_pending_orders() to authenticated;
revoke all on function public.create_order(uuid, jsonb, boolean) from public;
grant execute on function public.create_order(uuid, jsonb, boolean) to anon, authenticated;
revoke all on function public.transfer_ticket(uuid, text, text) from public, anon;
grant execute on function public.transfer_ticket(uuid, text, text) to authenticated;

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
revoke all on public.tiers_public from anon, authenticated;
grant select on public.tiers_public to anon, authenticated;
