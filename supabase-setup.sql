-- =====================================================================
--  REPOSITORIO UCA - estructura para Supabase
--  Pegalo COMPLETO en Supabase > SQL Editor y tocá "Run".
--  Es seguro ejecutarlo más de una vez.
-- =====================================================================

-- ---------- TABLAS ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  sede text not null,
  career text not null,
  year smallint not null check (year between 1 and 7),
  created_at timestamptz not null default now()
);

create table if not exists public.materials (
  id bigint generated always as identity primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 5 and 90),
  subject text not null check (char_length(subject) between 2 and 80),
  sede text not null,
  career text not null,
  year smallint not null check (year between 1 and 7),
  type text not null check (type in ('Resumen','Examen','Guía','Apunte')),
  format text not null check (format in ('PDF','DOCX','PPTX','IMG')),
  uploader text not null default '',
  d date not null default current_date,
  up integer not null default 0,
  down integer not null default 0,
  dl integer not null default 0,
  pages integer not null default 1 check (pages between 1 and 500),
  descr text not null default '' check (char_length(descr) <= 300),
  preview text not null default '',
  tags text[] not null default '{}',
  file_path text,
  file_name text
);
create index if not exists materials_owner_idx on public.materials (owner);
create index if not exists materials_d_idx on public.materials (d desc);

create table if not exists public.comments (
  id bigint generated always as identity primary key,
  material_id bigint not null references public.materials(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  who text not null default '',
  t text not null check (char_length(t) between 1 and 280),
  d date not null default current_date
);
create index if not exists comments_material_idx on public.comments (material_id);

create table if not exists public.votes (
  user_id uuid not null references auth.users(id) on delete cascade,
  material_id bigint not null references public.materials(id) on delete cascade,
  v smallint not null check (v in (1,-1)),
  primary key (user_id, material_id)
);

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  material_id bigint not null references public.materials(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) between 2 and 80),
  detail text not null default '' check (char_length(detail) <= 300),
  d date not null default current_date
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ic text not null default 'star',
  t text not null,
  ref text not null default 'home',
  read boolean not null default false,
  d date not null default current_date
);
create index if not exists notifications_user_idx on public.notifications (user_id, id desc);

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);

-- ---------- FUNCIONES Y TRIGGERS ----------
create or replace function public.notify(p_user uuid, p_ic text, p_t text, p_ref text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, ic, t, ref) values (p_user, p_ic, p_t, p_ref);
  delete from public.notifications
   where user_id = p_user
     and id not in (select id from public.notifications where user_id = p_user order by id desc limit 40);
end $$;

-- Al registrarse alguien: se crea su perfil, sus datos y un aviso de bienvenida
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); y int;
begin
  begin y := (meta->>'year')::int; exception when others then y := 1; end;
  if y is null or y < 1 or y > 7 then y := 1; end if;
  insert into public.profiles (id, name, sede, career, year)
  values (
    new.id,
    left(coalesce(nullif(trim(meta->>'name'), ''), split_part(coalesce(new.email, 'alumno'), '@', 1)), 60),
    coalesce(nullif(trim(meta->>'sede'), ''), 'Sede Mendoza'),
    coalesce(nullif(trim(meta->>'career'), ''), 'Sin carrera'),
    y
  ) on conflict (id) do nothing;
  insert into public.user_data (user_id, data) values (new.id, '{}'::jsonb) on conflict do nothing;
  perform public.notify(new.id, 'star', '¡Bienvenido/a al Repositorio UCA! Explorá, guardá y compartí material.', 'explore');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- El nombre del autor se toma del perfil (no se puede falsificar)
create or replace function public.set_uploader()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select name into new.uploader from public.profiles where id = new.owner;
  new.uploader := coalesce(new.uploader, '');
  return new;
end $$;
drop trigger if exists materials_set_uploader on public.materials;
create trigger materials_set_uploader before insert on public.materials
  for each row execute function public.set_uploader();

create or replace function public.sync_uploader()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.name is distinct from old.name then
    update public.materials set uploader = new.name where owner = new.id;
  end if;
  return new;
end $$;
drop trigger if exists profiles_sync_uploader on public.profiles;
create trigger profiles_sync_uploader after update on public.profiles
  for each row execute function public.sync_uploader();

create or replace function public.set_comment_author()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select name into new.who from public.profiles where id = new.user_id;
  new.who := coalesce(new.who, '');
  return new;
end $$;
drop trigger if exists comments_set_author on public.comments;
create trigger comments_set_author before insert on public.comments
  for each row execute function public.set_comment_author();

create or replace function public.comment_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare m public.materials%rowtype;
begin
  select * into m from public.materials where id = new.material_id;
  if found and m.owner <> new.user_id then
    perform public.notify(m.owner, 'comment', new.who || ' comentó en tu aporte "' || m.title || '"', 'comments/' || m.id);
  end if;
  return new;
end $$;
drop trigger if exists comments_notify on public.comments;
create trigger comments_notify after insert on public.comments
  for each row execute function public.comment_notify();

-- Votar: un voto por persona, se puede cambiar o sacar. Devuelve 1, -1 o 0.
create or replace function public.cast_vote(p_material bigint, p_v smallint)
returns smallint language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.materials%rowtype; cur smallint; nv smallint;
begin
  if uid is null then raise exception 'Tenés que ingresar para votar.'; end if;
  if p_v not in (1,-1) then raise exception 'Voto inválido.'; end if;
  select * into m from public.materials where id = p_material for update;
  if not found then raise exception 'Ese material ya no existe.'; end if;
  if m.owner = uid then raise exception 'No podés votar tu propio aporte.'; end if;
  select v into cur from public.votes where user_id = uid and material_id = p_material;
  if cur = 1 then update public.materials set up = up - 1 where id = p_material;
  elsif cur = -1 then update public.materials set down = down - 1 where id = p_material; end if;
  if cur is not null and cur = p_v then
    delete from public.votes where user_id = uid and material_id = p_material;
    nv := 0;
  else
    insert into public.votes (user_id, material_id, v) values (uid, p_material, p_v)
      on conflict (user_id, material_id) do update set v = excluded.v;
    if p_v = 1 then
      update public.materials set up = up + 1 where id = p_material;
      perform public.notify(m.owner, 'star', 'Tu aporte "' || m.title || '" recibió un voto útil', 'doc/' || m.id);
    else
      update public.materials set down = down + 1 where id = p_material;
    end if;
    nv := p_v;
  end if;
  return nv;
end $$;

-- Contar una descarga
create or replace function public.register_download(p_material bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.materials%rowtype;
begin
  if uid is null then raise exception 'Tenés que ingresar para descargar.'; end if;
  update public.materials set dl = dl + 1 where id = p_material returning * into m;
  if not found then raise exception 'Ese material ya no existe.'; end if;
  if m.owner <> uid and m.dl % 10 = 0 then
    perform public.notify(m.owner, 'download', 'Tu aporte "' || m.title || '" ya se descargó ' || m.dl || ' veces', 'doc/' || m.id);
  end if;
  return m.dl;
end $$;

-- ---------- RANKING ----------
create or replace view public.ranking with (security_invoker = true) as
  select p.id, p.name as n, p.sede as s,
         count(m.id)::int as up,
         (count(m.id) * 10 + coalesce(sum(m.up), 0))::int as pts
  from public.profiles p join public.materials m on m.owner = p.id
  group by p.id, p.name, p.sede;

-- ---------- SEGURIDAD (RLS): cada persona edita solo lo suyo ----------
alter table public.profiles      enable row level security;
alter table public.materials     enable row level security;
alter table public.comments      enable row level security;
alter table public.votes         enable row level security;
alter table public.reports       enable row level security;
alter table public.notifications enable row level security;
alter table public.user_data     enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists materials_select on public.materials;
create policy materials_select on public.materials for select to authenticated using (true);
drop policy if exists materials_insert on public.materials;
create policy materials_insert on public.materials for insert to authenticated
  with check (owner = auth.uid() and up = 0 and down = 0 and dl = 0);
drop policy if exists materials_delete on public.materials;
create policy materials_delete on public.materials for delete to authenticated using (owner = auth.uid());

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated using (true);
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated with check (user_id = auth.uid());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated using (user_id = auth.uid());

drop policy if exists votes_select on public.votes;
create policy votes_select on public.votes for select to authenticated using (user_id = auth.uid());

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated with check (user_id = auth.uid());

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_data_select on public.user_data;
create policy user_data_select on public.user_data for select to authenticated using (user_id = auth.uid());
drop policy if exists user_data_insert on public.user_data;
create policy user_data_insert on public.user_data for insert to authenticated with check (user_id = auth.uid());
drop policy if exists user_data_update on public.user_data;
create policy user_data_update on public.user_data for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- PERMISOS ----------
grant usage on schema public to authenticated;
grant select on public.profiles, public.materials, public.comments, public.votes, public.notifications, public.user_data, public.ranking to authenticated;
grant update on public.profiles, public.notifications, public.user_data to authenticated;
grant insert on public.materials, public.comments, public.reports, public.user_data to authenticated;
grant delete on public.materials, public.comments to authenticated;

revoke execute on function public.cast_vote(bigint, smallint) from public, anon;
revoke execute on function public.register_download(bigint) from public, anon;
revoke execute on function public.notify(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.cast_vote(bigint, smallint) to authenticated;
grant execute on function public.register_download(bigint) to authenticated;

-- ---------- ARCHIVOS (Storage) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('materials', 'materials', true, 20971520, array[
  'application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg','image/png'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "materials_upload_own" on storage.objects;
create policy "materials_upload_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'materials' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "materials_delete_own" on storage.objects;
create policy "materials_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'materials' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- TIEMPO REAL ----------
do $$ begin alter publication supabase_realtime add table public.materials;     exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.comments;      exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end $$;
