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
--  • 好友可以在今天的畫上留言；留言是很小的純文字，永久保留給畫的主人。
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


-- 推薦好友：先列出「共同好友」最多的人，不夠再用最近加入的人補滿。
-- 排除自己、已是好友、以及任一方向還有待回覆邀請的人。
-- 因為 RLS 只讓你看到自己的好友關係，這裡用 security definer 在資料庫內計算，
-- 只回傳「共同好友的數量」，不會洩漏共同好友是誰（也就不洩漏別人的好友名單）。
create or replace function public.suggest_friends(max_count int default 8)
returns table (id uuid, username text, display_name text, mutual_count int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  lim int := least(greatest(coalesce(max_count, 8), 1), 20);
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  return query
  with my_friends as (
    select case when f.requester = me then f.addressee else f.requester end as fid
      from public.friendships f
     where f.status = 'accepted' and me in (f.requester, f.addressee)
  ),
  mutual as (
    select case when f.requester = mf.fid then f.addressee else f.requester end as cid,
           count(*) as n
      from public.friendships f
      join my_friends mf on mf.fid in (f.requester, f.addressee)
     where f.status = 'accepted'
       and me not in (f.requester, f.addressee)
     group by 1
  )
  select p.id, p.username, p.display_name, coalesce(m.n, 0)::int as mutual_count
    from public.profiles p
    left join mutual m on m.cid = p.id
   where p.id <> me
     and not exists (
       select 1 from public.friendships r
        where (r.requester = me and r.addressee = p.id)
           or (r.requester = p.id and r.addressee = me))
   order by coalesce(m.n, 0) desc, p.created_at desc, p.username
   limit lim;
end;
$$;

revoke execute on function public.suggest_friends(int) from public, anon;
grant execute on function public.suggest_friends(int) to authenticated;


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


-- ── 5. 畫的留言（永久保留，不跟著畫一起刪除）──────────────────────────
--  • 好友可以在「還沒過期」的畫上留言；畫的主人能永遠看到所有留言。
--  • drawing_id 刻意不設外鍵：畫過了今天就會被清掉，留言要留下來。
--  • drawing_owner、day 由觸發器從畫本身複製，前端無法偽造。
create table if not exists public.drawing_comments (
  id            uuid primary key default gen_random_uuid(),
  drawing_id    uuid not null,
  drawing_owner uuid not null references public.profiles (id) on delete cascade,
  author        uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  day           date not null,
  body          text not null check (char_length(body) between 1 and 200),
  created_at    timestamptz not null default now()
);

create index if not exists drawing_comments_drawing_idx on public.drawing_comments (drawing_id, created_at);
create index if not exists drawing_comments_owner_idx on public.drawing_comments (drawing_owner, day);

alter table public.drawing_comments enable row level security;

-- 這張畫還沒過期嗎？（給 RLS 用，不受 drawings 的讀取規則影響）
create or replace function public.drawing_is_live(d uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.drawings where id = d and expires_at > now());
$$;

revoke execute on function public.drawing_is_live(uuid) from public, anon;
grant execute on function public.drawing_is_live(uuid) to authenticated;

-- 誰看得到：畫的主人與留言者（永遠）；主人的好友（只在畫還沒過期時）
drop policy if exists "comments: owner, author, or friends while live" on public.drawing_comments;
create policy "comments: owner, author, or friends while live" on public.drawing_comments
  for select to authenticated
  using (
    drawing_owner = (select auth.uid())
    or author = (select auth.uid())
    or (public.is_my_friend(drawing_owner) and public.drawing_is_live(drawing_id))
  );

-- 誰能留言：作者必須是自己；畫還沒過期；畫的主人本人或主人的好友
drop policy if exists "comments: insert as friend or owner" on public.drawing_comments;
create policy "comments: insert as friend or owner" on public.drawing_comments
  for insert to authenticated
  with check (
    author = (select auth.uid())
    and public.drawing_is_live(drawing_id)
    and (drawing_owner = (select auth.uid()) or public.is_my_friend(drawing_owner))
  );

-- 留言不能修改；留言者或畫的主人可以刪除
drop policy if exists "comments: delete own or on own drawing" on public.drawing_comments;
create policy "comments: delete own or on own drawing" on public.drawing_comments
  for delete to authenticated
  using (author = (select auth.uid()) or drawing_owner = (select auth.uid()));

revoke all on public.drawing_comments from anon;
revoke update on public.drawing_comments from authenticated;
grant select, insert, delete on public.drawing_comments to authenticated;

-- 寫入時把關：從畫複製 drawing_owner / day、畫必須還沒過期、每人每張畫最多 30 則
create or replace function public.guard_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drawings%rowtype;
begin
  select * into d from public.drawings where id = new.drawing_id;
  if not found or d.expires_at <= now() then
    raise exception 'drawing is not live';
  end if;
  new.drawing_owner := d.user_id;
  new.day := d.day;
  new.created_at := now();
  new.body := btrim(new.body);
  if (select count(*) from public.drawing_comments c
       where c.drawing_id = new.drawing_id and c.author = new.author) >= 30 then
    raise exception 'comment limit reached';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_comment() from public, anon;

drop trigger if exists drawing_comments_guard on public.drawing_comments;
create trigger drawing_comments_guard
  before insert on public.drawing_comments
  for each row execute function public.guard_comment();


-- ── 6. 自動清除過期資料 ──────────────────────────────────────────
-- 只清畫與當天文字；留言（drawing_comments）刻意不清，畫的主人要永遠看得到。
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
