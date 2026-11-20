-- Household Hub sync: run once in the Supabase SQL editor (Database > SQL editor > New query > paste > Run).
-- Safe to run again: it replaces the functions and leaves existing data alone.
--
-- What it sets up
--   hub_households  one row per household
--   hub_members     the two people in a household, each in a slot (p1 or p2)
--   hub_invites     an invite for the second person, matched by their sign-in email
--   hub_records     the household's data, one row per bill, debt, payment, cost, change and so on
--
-- Who can do what
--   Only the two members of a household can read its rows. Nobody writes rows directly:
--   every write goes through hub_push, which checks membership and these rules:
--     * a person can sign, decline or approve only for their own slot
--     * a signature, once given, cannot be removed or altered; it is cleared only when the
--       proposal itself changes, so a signature always belongs to the terms that were signed
--     * a change can be marked Signed only when both people have signed it
--     * a closed change (Signed, Declined, Withdrawn) is final, and changes are never deleted
--     * when both phones edit the same record, the later edit wins
--     * the one exception is the starting upload: while only the first person has joined, and within
--       an hour of starting, existing history comes in as it was on their phone


create table if not exists public.hub_households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.hub_members (
  household_id uuid not null references public.hub_households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  slot text not null check (slot in ('p1', 'p2')),
  email text,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (household_id, slot)
);

create table if not exists public.hub_invites (
  household_id uuid not null references public.hub_households (id) on delete cascade,
  slot text not null check (slot in ('p1', 'p2')),
  email text not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household_id, slot)
);

create table if not exists public.hub_records (
  household_id uuid not null references public.hub_households (id) on delete cascade,
  key text not null,
  data jsonb,
  deleted boolean not null default false,
  edited_at timestamptz not null,
  edited_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (household_id, key)
);
create index if not exists hub_records_updated on public.hub_records (household_id, updated_at);

-- ---------- helpers ----------
create or replace function public.hub_slot(h uuid) returns text
language sql stable security definer set search_path = public as $$
  select slot from public.hub_members where household_id = h and user_id = auth.uid()
$$;

create or replace function public.hub_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

-- a JSON value that is missing or JSON null counts as empty
create or replace function public.hub_v(j jsonb) returns jsonb
language sql immutable as $$ select case when j is null or jsonb_typeof(j) = 'null' then null else j end $$;

-- ---------- row level security ----------
alter table public.hub_households enable row level security;
alter table public.hub_members enable row level security;
alter table public.hub_invites enable row level security;
alter table public.hub_records enable row level security;

drop policy if exists hub_households_read on public.hub_households;
create policy hub_households_read on public.hub_households for select to authenticated
  using (public.hub_slot(id) is not null);

drop policy if exists hub_members_read on public.hub_members;
create policy hub_members_read on public.hub_members for select to authenticated
  using (public.hub_slot(household_id) is not null);

drop policy if exists hub_invites_read on public.hub_invites;
create policy hub_invites_read on public.hub_invites for select to authenticated
  using (public.hub_slot(household_id) is not null or lower(email) = public.hub_email());

drop policy if exists hub_records_read on public.hub_records;
create policy hub_records_read on public.hub_records for select to authenticated
  using (public.hub_slot(household_id) is not null);

-- no insert, update or delete policies: writes only go through the functions below
revoke insert, update, delete on public.hub_households, public.hub_members, public.hub_invites, public.hub_records from anon, authenticated;
revoke all on public.hub_households, public.hub_members, public.hub_invites, public.hub_records from anon;
grant select on public.hub_households, public.hub_members, public.hub_invites, public.hub_records to authenticated;

-- ---------- households and invites ----------
create or replace function public.hub_create_household(p_slot text, p_name text default 'Our household') returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_slot not in ('p1', 'p2') then raise exception 'Pick which person you are'; end if;
  insert into hub_households (name, created_by) values (coalesce(nullif(trim(p_name), ''), 'Our household'), auth.uid()) returning id into h;
  insert into hub_members (household_id, user_id, slot, email) values (h, auth.uid(), p_slot, public.hub_email());
  return h;
end $$;

create or replace function public.hub_invite(h uuid, p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare me text := public.hub_slot(h); other text;
begin
  if me is null then raise exception 'You are not in this household'; end if;
  other := case me when 'p1' then 'p2' else 'p1' end;
  if exists (select 1 from hub_members where household_id = h and slot = other) then raise exception 'Both people have already joined'; end if;
  if coalesce(trim(p_email), '') = '' then raise exception 'Enter their email'; end if;
  insert into hub_invites (household_id, slot, email, created_by) values (h, other, lower(trim(p_email)), auth.uid())
    on conflict (household_id, slot) do update set email = excluded.email, created_by = excluded.created_by, created_at = now();
  return other;
end $$;

create or replace function public.hub_accept_invite() returns uuid
language plpgsql security definer set search_path = public as $$
declare inv hub_invites;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into inv from hub_invites where lower(email) = public.hub_email() order by created_at desc limit 1;
  if inv.household_id is null then return null; end if;
  insert into hub_members (household_id, user_id, slot, email) values (inv.household_id, auth.uid(), inv.slot, public.hub_email())
    on conflict (household_id, user_id) do nothing;
  delete from hub_invites where household_id = inv.household_id and slot = inv.slot;
  return inv.household_id;
end $$;

-- ---------- the rules for signatures and approvals ----------
create or replace function public.hub_check_change(o jsonb, n jsonb, me text) returns jsonb
language plpgsql stable set search_path = public as $$
declare s text; os jsonb; ns jsonb; content_changed boolean; st text;
begin
  if o is not null and coalesce(o ->> 'status', 'Pending') <> 'Pending' then
    if n is distinct from o then raise exception 'This change is already closed'; end if;
    return o;
  end if;
  content_changed := o is not null and (
    (o -> 'after') is distinct from (n -> 'after') or (o -> 'before') is distinct from (n -> 'before')
    or (o ->> 'target') is distinct from (n ->> 'target') or (o ->> 'targetId') is distinct from (n ->> 'targetId')
    or (o ->> 'action') is distinct from (n ->> 'action'));
  foreach s in array array['p1', 'p2'] loop
    os := public.hub_v(o -> 'sig' -> s);
    ns := public.hub_v(n -> 'sig' -> s);
    if content_changed then
      -- the proposal itself changed: earlier signatures no longer apply; the editor may sign the new terms
      if s = me and ns is not null then
        n := jsonb_set(n, array['sig', s], ns || jsonb_build_object('user', auth.uid(), 'email', public.hub_email()), true);
      else
        n := jsonb_set(n, array['sig', s], 'null'::jsonb, true);
      end if;
    elsif os is not null then
      -- a signature stays exactly as it was given
      n := jsonb_set(n, array['sig', s], os, true);
    elsif ns is not null then
      if s <> me then raise exception 'Only that person can sign or decline for themselves'; end if;
      n := jsonb_set(n, array['sig', s], ns || jsonb_build_object('user', auth.uid(), 'email', public.hub_email()), true);
    end if;
  end loop;
  st := coalesce(n ->> 'status', 'Pending');
  if st = 'Signed' and not (
      public.hub_v(n -> 'sig' -> 'p1' -> 'at') is not null and public.hub_v(n -> 'sig' -> 'p2' -> 'at') is not null
      and coalesce((n -> 'sig' -> 'p1' ->> 'declined')::boolean, false) = false
      and coalesce((n -> 'sig' -> 'p2' ->> 'declined')::boolean, false) = false) then
    raise exception 'A change takes effect only when both people have signed it';
  end if;
  if st = 'Declined' and not (coalesce((n -> 'sig' -> 'p1' ->> 'declined')::boolean, false) or coalesce((n -> 'sig' -> 'p2' ->> 'declined')::boolean, false)) then
    raise exception 'Only a person who declined can close a change as declined';
  end if;
  return n;
end $$;

create or replace function public.hub_check_approvals(o jsonb, n jsonb, me text) returns void
language plpgsql immutable as $$
declare s text;
begin
  foreach s in array array['p1', 'p2'] loop
    if s <> me and public.hub_v(o -> 'approvals' -> s) is distinct from public.hub_v(n -> 'approvals' -> s) then
      raise exception 'Only that person can approve or decline for themselves';
    end if;
  end loop;
end $$;

-- ---------- writing ----------
-- rows: [{ "key": "bills/<id>", "data": {...} or null, "deleted": false, "edited_at": "<iso>" }, ...]
-- returns one row per key with the stored result, so the phone can match the server
create or replace function public.hub_push(h uuid, rows jsonb)
returns table (key text, ok boolean, reason text, data jsonb, deleted boolean, edited_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me text := public.hub_slot(h);
  r jsonb; k text; coll text; nd jsonb; del boolean; ed timestamptz; cur hub_records; starting boolean;
begin
  if me is null then raise exception 'You are not in this household'; end if;
  -- the starting upload: the first person brings the household's existing history, signatures and
  -- approvals as they were, while they are the only member and within an hour of starting
  select (select count(*) from hub_members m where m.household_id = h) < 2 and hh.created_at > now() - interval '1 hour'
    into starting from hub_households hh where hh.id = h;
  for r in select * from jsonb_array_elements(rows) loop
    k := r ->> 'key';
    coll := split_part(k, '/', 1);
    nd := public.hub_v(r -> 'data');
    del := coalesce((r ->> 'deleted')::boolean, false) or nd is null;
    ed := least(coalesce((r ->> 'edited_at')::timestamptz, now()), now() + interval '5 minutes');
    select * into cur from hub_records x where x.household_id = h and x.key = k;
    begin
      if k is null or coll = '' then raise exception 'Bad key'; end if;
      if cur.key is not null and cur.edited_at > ed and coll <> 'changes' then
        raise exception 'newer';
      end if;
      if starting and cur.key is null then
        null;
      elsif coll = 'changes' then
        if del then raise exception 'Agreement history cannot be deleted'; end if;
        nd := public.hub_check_change(case when cur.deleted then null else cur.data end, nd, me);
      elsif coll in ('payments', 'misc') and not del then
        perform public.hub_check_approvals(case when cur.deleted then null else cur.data end, nd, me);
      end if;
      insert into hub_records as t (household_id, key, data, deleted, edited_at, edited_by, updated_at)
        values (h, k, case when del then null else nd end, del, greatest(ed, coalesce(cur.edited_at, ed)), auth.uid(), clock_timestamp())
        on conflict (household_id, key) do update
          set data = excluded.data, deleted = excluded.deleted, edited_at = excluded.edited_at,
              edited_by = excluded.edited_by, updated_at = excluded.updated_at;
      select x.key, true, null::text, x.data, x.deleted, x.edited_at into key, ok, reason, data, deleted, edited_at
        from hub_records x where x.household_id = h and x.key = k;
      return next;
    exception when others then
      key := k; ok := false; reason := sqlerrm;
      data := cur.data; deleted := coalesce(cur.deleted, true); edited_at := cur.edited_at;
      return next;
    end;
  end loop;
end $$;

revoke execute on function public.hub_create_household(text, text), public.hub_invite(uuid, text), public.hub_accept_invite(),
  public.hub_push(uuid, jsonb), public.hub_slot(uuid) from public, anon;
grant execute on function public.hub_create_household(text, text), public.hub_invite(uuid, text), public.hub_accept_invite(),
  public.hub_push(uuid, jsonb), public.hub_slot(uuid) to authenticated;

-- ---------- live updates ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'hub_records') then
    alter publication supabase_realtime add table public.hub_records;
  end if;
end $$;
