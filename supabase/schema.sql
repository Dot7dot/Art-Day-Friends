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

-- 大頭貼：160×160 的 JPEG data URL（約 10–20 KB），空值 = 顯示暱稱的第一個字
alter table public.profiles add column if not exists avatar text;
alter table public.profiles drop constraint if exists profiles_avatar_check;
alter table public.profiles add constraint profiles_avatar_check
  check (avatar is null or (avatar ~ '^data:image/(jpeg|png|webp);base64,' and char_length(avatar) <= 60000));

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
grant update (display_name, avatar) on public.profiles to authenticated;   -- 只能改暱稱與大頭貼，不能改 ID

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
-- （回傳欄位多了 avatar；create or replace 不能改回傳型態，所以先 drop，下面再重新授權）
drop function if exists public.suggest_friends(int);
create function public.suggest_friends(max_count int default 8)
returns table (id uuid, username text, display_name text, avatar text, mutual_count int)
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
  select p.id, p.username, p.display_name, p.avatar, coalesce(m.n, 0)::int as mutual_count
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


-- ── 7. 忘記密碼：兩個安全問題 ────────────────────────────────────
-- 帳號沒有信箱，所以讓使用者「選填」兩個問題（最喜歡的動物＋國小），
-- 忘記密碼時答對就能自己重設。答案只存 bcrypt 雜湊，連管理者都看不到。
--   • 雜湊的內容是「動物代號|整理過的學校名稱」；整理規則（NFKC、去空白與標點、
--     臺→台、去掉結尾的國小）與 js/recovery.js 完全相同。
--   • 兩張表都開 RLS 而且不給任何直接權限，一律透過下面的函式存取。
--   • 同一個帳號 24 小時內答錯 5 次就先鎖住（回傳 'locked'）。
--   • 重設失敗時「回傳狀態文字」而不是丟出錯誤，這樣失敗紀錄才不會被 rollback。
--   需要 pgcrypto（Supabase 內建在 extensions schema）。

create table if not exists public.recovery_answers (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  answer_hash text not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.recovery_attempts (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  attempted_at timestamptz not null default now(),
  success      boolean not null
);

create index if not exists recovery_attempts_user_idx on public.recovery_attempts (user_id, attempted_at);

alter table public.recovery_answers enable row level security;
alter table public.recovery_attempts enable row level security;
-- 刻意不建立任何 policy，並收回所有直接權限
revoke all on public.recovery_answers from public, anon, authenticated;
revoke all on public.recovery_attempts from public, anon, authenticated;

-- 可選的動物代號（要和 js/recovery.js 一致）
create or replace function public.recovery_animals()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['poison_dart_frog', 'red_fire_ant', 'tardigrade', 'platypus', 'axolotl',
               'shoebill', 'tarsier', 'naked_mole_rat', 'mantis_shrimp', 'sunfish'];
$$;

-- 學校名稱整理：NFKC → 去頭尾空白 → 小寫 → 去掉所有空白與標點 → 臺→台 → 去掉結尾的 國民小學／國小／小學
-- 可能回傳空字串（呼叫的人要檢查）
create or replace function public.recovery_norm_school(s text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
           replace(
             regexp_replace(
               lower(btrim(normalize(coalesce(s, ''), NFKC))),
               '[\s!-/:-@\[-`{-~ -¿ -⁯⸀-⹿　-〿︰-﹏]', '', 'g'),
             '臺', '台'),
           '(國民小學|國小|小學)$', '');
$$;

create or replace function public.recovery_secret(animal text, school text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(animal, '') || '|' || public.recovery_norm_school(school);
$$;

revoke execute on function public.recovery_animals() from public, anon, authenticated;
revoke execute on function public.recovery_norm_school(text) from public, anon, authenticated;
revoke execute on function public.recovery_secret(text, text) from public, anon, authenticated;

-- 設定／修改自己的答案
create or replace function public.set_recovery_answers(animal text, school text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  if animal is null or not (animal = any (public.recovery_animals())) then
    raise exception 'invalid recovery animal';
  end if;
  if char_length(public.recovery_norm_school(school)) < 1 or char_length(coalesce(school, '')) > 60 then
    raise exception 'invalid recovery school';
  end if;
  insert into public.recovery_answers (user_id, answer_hash, updated_at)
  values (uid, extensions.crypt(public.recovery_secret(animal, school), extensions.gen_salt('bf')), now())
  on conflict (user_id) do update
    set answer_hash = excluded.answer_hash, updated_at = now();
end;
$$;

create or replace function public.clear_recovery_answers()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from public.recovery_answers where user_id = auth.uid();
end;
$$;

create or replace function public.recovery_status()
returns table (has_answers boolean, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
    select true, r.updated_at from public.recovery_answers r where r.user_id = auth.uid();
  if not found then
    return query select false, null::timestamptz;
  end if;
end;
$$;

-- 這個使用者 ID 有沒有設定過問題（登入前就要能問）
create or replace function public.recovery_available(username text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
      join public.recovery_answers r on r.user_id = p.id
     where p.username = lower(btrim(coalesce(recovery_available.username, '')))
  );
$$;

-- 用答案重設密碼。回傳 'ok' | 'wrong' | 'locked' | 'weak_password'
create or replace function public.reset_password_with_answers(
  username text, animal text, school text, new_password text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
  hash text;
  fails integer;
begin
  select p.id, r.answer_hash into uid, hash
    from public.profiles p
    left join public.recovery_answers r on r.user_id = p.id
   where p.username = lower(btrim(coalesce(reset_password_with_answers.username, '')));

  -- 找不到使用者、或沒有設定答案：和答錯同樣回應
  if uid is null or hash is null then
    return 'wrong';
  end if;

  -- 同一個帳號同時嘗試時排隊，避免繞過次數限制
  perform 1 from public.profiles where id = uid for update;

  delete from public.recovery_attempts where user_id = uid and attempted_at < now() - interval '24 hours';
  select count(*) into fails from public.recovery_attempts
   where user_id = uid and not success and attempted_at > now() - interval '24 hours';
  if fails >= 5 then
    return 'locked';
  end if;

  if char_length(coalesce(new_password, '')) < 6 then
    return 'weak_password';
  end if;

  if reset_password_with_answers.animal is null or not (reset_password_with_answers.animal = any (public.recovery_animals()))
     or char_length(public.recovery_norm_school(school)) < 1
     or hash <> extensions.crypt(public.recovery_secret(animal, school), hash) then
    insert into public.recovery_attempts (user_id, success) values (uid, false);
    return 'wrong';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = uid;

  -- 讓舊的登入失效（資料表不存在或沒權限時略過，不影響重設）
  begin
    delete from auth.refresh_tokens where user_id = uid::text;
  exception when others then
    null;
  end;
  begin
    delete from auth.sessions where user_id = uid;
  exception when others then
    null;
  end;

  delete from public.recovery_attempts where user_id = uid and not success;
  insert into public.recovery_attempts (user_id, success) values (uid, true);
  return 'ok';
end;
$$;

revoke execute on function public.set_recovery_answers(text, text) from public, anon;
revoke execute on function public.clear_recovery_answers() from public, anon;
revoke execute on function public.recovery_status() from public, anon;
revoke execute on function public.recovery_available(text) from public;
revoke execute on function public.reset_password_with_answers(text, text, text, text) from public;
grant execute on function public.set_recovery_answers(text, text) to authenticated;
grant execute on function public.clear_recovery_answers() to authenticated;
grant execute on function public.recovery_status() to authenticated;
grant execute on function public.recovery_available(text) to anon, authenticated;
grant execute on function public.reset_password_with_answers(text, text, text, text) to anon, authenticated;
