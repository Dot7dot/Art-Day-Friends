-- ════════════════════════════════════════════════════════════════
--  Art Day · Supabase 資料庫設定
--  使用方式：Supabase Dashboard → SQL Editor → 貼上整份 → Run
--  可以重複執行（會更新成最新設定，不會刪掉資料）
-- ════════════════════════════════════════════════════════════════
--
--  設計重點
--  • 圖片「大部分存在本機」：雲端只放每個人「今天」的壓縮副本。
--  • 每筆雲端資料都有 expires_at（上傳者當地的「今天結束」時間），
--    過期後好友就讀不到（RLS 擋住），並由排程／App 自動刪除。
--  • 只有互相是好友（accepted）的人，才看得到對方今天的畫與文字。
-- ════════════════════════════════════════════════════════════════


-- ── 1. 個人檔案 ─────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 30),
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: signed-in users can read" on public.profiles;
create policy "profiles: signed-in users can read" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

revoke all on public.profiles from anon;
revoke update on public.profiles from authenticated;
grant select, insert on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;   -- 只能改暱稱，不能改 ID

-- 註冊時自動建立個人檔案（從註冊表單帶來的 username / display_name）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uname text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  dname text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
begin
  if uname !~ '^[a-z0-9_]{3,20}$' then
    uname := 'artist_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  if dname = '' then
    dname := uname;
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, uname, left(dname, 30));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 註冊前檢查使用者 ID 是否可用（未登入也能呼叫，只回傳 true/false）
create or replace function public.username_available(name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.profiles where username = lower(name));
$$;

revoke execute on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;


-- ── 2. 好友 ─────────────────────────────────────────────────────
create table if not exists public.friendships (
  requester  uuid not null references public.profiles (id) on delete cascade,
  addressee  uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);

-- 同一對人只能有一筆關係（不論誰先邀請）
create unique index if not exists friendships_pair_key
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

alter table public.friendships enable row level security;

drop policy if exists "friendships: see own" on public.friendships;
create policy "friendships: see own" on public.friendships
  for select to authenticated using ((select auth.uid()) in (requester, addressee));

drop policy if exists "friendships: send request" on public.friendships;
create policy "friendships: send request" on public.friendships
  for insert to authenticated with check (requester = (select auth.uid()) and status = 'pending');

drop policy if exists "friendships: accept request" on public.friendships;
create policy "friendships: accept request" on public.friendships
  for update to authenticated
  using (addressee = (select auth.uid()))
  with check (addressee = (select auth.uid()) and status = 'accepted');

drop policy if exists "friendships: remove" on public.friendships;
create policy "friendships: remove" on public.friendships
  for delete to authenticated using ((select auth.uid()) in (requester, addressee));

revoke all on public.friendships from anon;
revoke update on public.friendships from authenticated;
grant select, insert, delete on public.friendships to authenticated;
grant update (status) on public.friendships to authenticated;

-- 送出好友邀請；如果對方已經邀請過你，就直接成為好友
create or replace function public.send_friend_request(target uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  existing public.friendships%rowtype;
begin
  if me is null then
    raise exception 'not signed in';
  end if;
  if target = me then
    raise exception 'cannot add yourself';
  end if;
  if not exists (select 1 from public.profiles where id = target) then
    raise exception 'user not found';
  end if;

  select * into existing from public.friendships
   where (requester = me and addressee = target) or (requester = target and addressee = me);

  if found then
    if existing.status = 'accepted' then
      return 'already_friends';
    elsif existing.requester = target then
      update public.friendships set status = 'accepted' where requester = target and addressee = me;
      return 'accepted';
    else
      return 'already_requested';
    end if;
  end if;

  insert into public.friendships (requester, addressee) values (me, target);
  return 'requested';
end;
$$;

revoke execute on function public.send_friend_request(uuid) from public, anon;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- 某人是不是「我」的好友（給 RLS 使用，只能查自己的好友關係）
create or replace function public.is_my_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and ((f.requester = auth.uid() and f.addressee = other)
         or (f.requester = other and f.addressee = auth.uid()))
  );
$$;

revoke execute on function public.is_my_friend(uuid) from public, anon;
grant execute on function public.is_my_friend(uuid) to authenticated;


-- ── 3. 今天的畫（只放當天，隔天刪除）───────────────────────────────
create table if not exists public.drawings (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  day        date not null,
  image      text not null check (image ~ '^data:image/(jpeg|png|webp);base64,' and char_length(image) <= 1500000),
  width      integer check (width between 1 and 8000),
  height     integer check (height between 1 and 8000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists drawings_user_expires_idx on public.drawings (user_id, expires_at);
create index if not exists drawings_expires_idx on public.drawings (expires_at);

alter table public.drawings enable row level security;

drop policy if exists "drawings: owner or friends today" on public.drawings;
create policy "drawings: owner or friends today" on public.drawings
  for select to authenticated
  using (user_id = (select auth.uid()) or (expires_at > now() and public.is_my_friend(user_id)));

drop policy if exists "drawings: insert own" on public.drawings;
create policy "drawings: insert own" on public.drawings
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "drawings: delete own" on public.drawings;
create policy "drawings: delete own" on public.drawings
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.drawings from anon;
revoke update on public.drawings from authenticated;
grant select, insert, delete on public.drawings to authenticated;

-- 寫入時把關：只能放「今天」的圖（expires_at 必須在 26 小時內），每天最多 6 張
create or replace function public.guard_drawing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  if new.expires_at <= now() or new.expires_at > now() + interval '26 hours' then
    raise exception 'expires_at must be the end of today';
  end if;
  if (select count(*) from public.drawings d
       where d.user_id = new.user_id and d.expires_at > now()) >= 6 then
    raise exception 'daily cloud limit reached';
  end if;
  return new;
end;
$$;

drop trigger if exists drawings_guard on public.drawings;
create trigger drawings_guard
  before insert on public.drawings
  for each row execute function public.guard_drawing();


-- ── 4. 今天的文字記錄（同樣只放當天）──────────────────────────────
create table if not exists public.day_notes (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  day        date not null,
  note       text not null check (char_length(note) <= 1000),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, day)
);

create index if not exists day_notes_expires_idx on public.day_notes (expires_at);

alter table public.day_notes enable row level security;

drop policy if exists "day_notes: owner or friends today" on public.day_notes;
create policy "day_notes: owner or friends today" on public.day_notes
  for select to authenticated
  using (user_id = (select auth.uid()) or (expires_at > now() and public.is_my_friend(user_id)));

drop policy if exists "day_notes: insert own" on public.day_notes;
create policy "day_notes: insert own" on public.day_notes
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "day_notes: update own" on public.day_notes;
create policy "day_notes: update own" on public.day_notes
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "day_notes: delete own" on public.day_notes;
create policy "day_notes: delete own" on public.day_notes
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.day_notes from anon;
grant select, insert, update, delete on public.day_notes to authenticated;

create or replace function public.guard_note()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.expires_at <= now() or new.expires_at > now() + interval '26 hours' then
    raise exception 'expires_at must be the end of today';
  end if;
  return new;
end;
$$;

drop trigger if exists day_notes_guard on public.day_notes;
create trigger day_notes_guard
  before insert or update on public.day_notes
  for each row execute function public.guard_note();


-- ── 5. 自動清除過期資料 ──────────────────────────────────────────
create or replace function public.purge_expired()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  m integer;
begin
  delete from public.drawings where expires_at <= now();
  get diagnostics n = row_count;
  delete from public.day_notes where expires_at <= now();
  get diagnostics m = row_count;
  return n + m;
end;
$$;

-- App 每次開啟都會呼叫一次（就算沒有排程也能清乾淨）
revoke execute on function public.purge_expired() from public, anon;
grant execute on function public.purge_expired() to authenticated;

-- 每 30 分鐘自動清一次（需要 pg_cron；若無法啟用，會顯示提示但不影響其他設定）
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('artday-purge-expired', '*/30 * * * *', 'select public.purge_expired();');
exception when others then
  raise notice 'pg_cron 尚未啟用（%）。可到 Dashboard → Integrations → Cron 開啟後再執行一次本檔；不開也沒關係，App 開啟時會自動清除。', sqlerrm;
end;
$$;
