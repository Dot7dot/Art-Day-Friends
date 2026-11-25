-- ════════════════════════════════════════════════════════════════
--  Art Day · Supabase 資料庫設定
--  使用方式：Supabase Dashboard → SQL Editor → 貼上整份 → Run
--  可以重複執行（會更新成最新設定，不會刪掉資料）
-- ════════════════════════════════════════════════════════════════
--
--  設計重點
--  • 圖片「大部分存在本機」：雲端只放每個人最近 24 小時內發佈的壓縮副本。
--  • 每筆雲端資料都有 expires_at（上傳那一刻起算 24 小時，由資料庫固定，不看日期、不看時區），
--    過期後好友就讀不到（RLS 擋住），並由排程／App 自動刪除。
--  • 只有互相是好友（accepted）的人，才看得到對方 24 小時內的畫與文字。
--  • 好友可以在還在分享中的畫上留言；留言是很小的純文字，永久保留給畫的主人。
--  • 推薦貼文（選擇加入）：profiles.share_public = true 的人，24 小時內的畫與文字
--    非好友也看得到（只能看，不能留言）。預設關閉，要使用者自己打開。
--  • 留言可以回覆別人（reply_to）；被回覆的人與被「戳」的人會收到通知（notifications）。
--  • 許願池（wishes）：使用者許願新功能，只有本人看得到自己的願望，網站管理員在 Dashboard 看全部。
--  • 打氣區（cheers）：登入的使用者互相留言打氣，每則保留 3 天，本人可編輯、刪除。
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

-- 推薦貼文：同意「非好友也能看到我 24 小時內的畫」。預設 false（要使用者自己開啟）
alter table public.profiles add column if not exists share_public boolean not null default false;

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
grant update (display_name, avatar, share_public) on public.profiles to authenticated;   -- 只能改暱稱、大頭貼與推薦設定，不能改 ID

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

-- 某人有沒有同意公開分享 24 小時內的畫（給 RLS 使用；security definer 才不會在 profiles 的規則裡繞圈）
create or replace function public.is_public_profile(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = uid and p.share_public);
$$;

revoke execute on function public.is_public_profile(uuid) from public, anon;
grant execute on function public.is_public_profile(uuid) to authenticated;


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


-- ── 3. 分享中的畫（每張從上傳起保留 24 小時）───────────────────────────────
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

-- 自己的永遠看得到；24 小時內的畫：好友，或同意公開分享（推薦貼文）的人
drop policy if exists "drawings: owner or friends today" on public.drawings;
create policy "drawings: owner or friends today" on public.drawings
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (expires_at > now() and (public.is_my_friend(user_id) or public.is_public_profile(user_id)))
  );

drop policy if exists "drawings: insert own" on public.drawings;
create policy "drawings: insert own" on public.drawings
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "drawings: delete own" on public.drawings;
create policy "drawings: delete own" on public.drawings
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.drawings from anon;
revoke update on public.drawings from authenticated;
grant select, insert, delete on public.drawings to authenticated;

-- 寫入時把關：expires_at 一律由資料庫設成「現在 + 24 小時」（不理會前端送來的值），
-- 同一時間最多 6 張還在分享中的畫
create or replace function public.guard_drawing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  new.expires_at := now() + interval '24 hours';
  if (select count(*) from public.drawings d
       where d.user_id = new.user_id and d.expires_at > now()) >= 6 then
    raise exception 'daily cloud limit reached (6 live drawings)';
  end if;
  return new;
end;
$$;

drop trigger if exists drawings_guard on public.drawings;
create trigger drawings_guard
  before insert on public.drawings
  for each row execute function public.guard_drawing();


-- 一次性升級（可重複執行）：舊版的 expires_at 是「當天午夜」，改成「上傳起 24 小時」。
-- 只延長還在分享中、且比 24 小時短的，已過期的不動。
update public.drawings set expires_at = created_at + interval '24 hours'
 where expires_at > now() and expires_at < created_at + interval '24 hours';

-- ── 4. 分享中的文字記錄（每次儲存後保留 24 小時）──────────────────────────────
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
  using (
    user_id = (select auth.uid())
    or (expires_at > now() and (public.is_my_friend(user_id) or public.is_public_profile(user_id)))
  );

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
  new.expires_at := now() + interval '24 hours'; -- 最後一次儲存後再分享 24 小時
  return new;
end;
$$;

drop trigger if exists day_notes_guard on public.day_notes;
create trigger day_notes_guard
  before insert or update on public.day_notes
  for each row execute function public.guard_note();

-- 一次性升級（可重複執行）：文字記錄同上，從最後儲存起算 24 小時。
-- guard_note 會在更新時把 updated_at 重設成現在，所以升級這一步暫時關掉它。
alter table public.day_notes disable trigger day_notes_guard;
update public.day_notes set expires_at = updated_at + interval '24 hours'
 where expires_at > now() and expires_at < updated_at + interval '24 hours';
alter table public.day_notes enable trigger day_notes_guard;


-- 推薦貼文：同意公開分享、不是我、和我沒有任何好友關係（含待回覆）、而且 24 小時內還有畫的人。
-- 共同好友多的在前，再依最近發佈時間。只回傳共同好友的「數量」，不洩漏是誰。
-- （不會用到 drawings 的 RLS：security definer 在資料庫內算，圖片仍由前端用一般查詢讀取）
drop function if exists public.recommended_posts(int);
create function public.recommended_posts(max_count int default 6)
returns table (user_id uuid, username text, display_name text, avatar text,
               mutual_count int, drawing_count int, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  lim int := least(greatest(coalesce(max_count, 6), 1), 20);
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
  ),
  live as (
    select d.user_id as uid, count(*)::int as cnt, max(d.created_at) as last_at
      from public.drawings d
     where d.expires_at > now()
     group by d.user_id
  )
  select p.id, p.username, p.display_name, p.avatar,
         coalesce(m.n, 0)::int, l.cnt, l.last_at
    from public.profiles p
    join live l on l.uid = p.id
    left join mutual m on m.cid = p.id
   where p.share_public
     and p.id <> me
     and not exists (
       select 1 from public.friendships r
        where (r.requester = me and r.addressee = p.id)
           or (r.requester = p.id and r.addressee = me))
   order by coalesce(m.n, 0) desc, l.last_at desc, p.username
   limit lim;
end;
$$;

revoke execute on function public.recommended_posts(int) from public, anon;
grant execute on function public.recommended_posts(int) to authenticated;

-- ── 5. 畫的留言（永久保留，不跟著畫一起刪除）──────────────────────────
--  • 好友可以在「還沒過期」的畫上留言；畫的主人能永遠看到所有留言。
--  • drawing_id 刻意不設外鍵：畫過了 24 小時就會被清掉，留言要留下來。
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

-- 回覆：指向被回覆的那則留言（同一張畫）；被回覆的留言刪除後變成 null
alter table public.drawing_comments add column if not exists reply_to uuid references public.drawing_comments (id) on delete set null;

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

-- 寫入時把關：從畫複製 drawing_owner / day、畫必須還沒過期、每人每張畫最多 30 則、回覆的對象必須在同一張畫上
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
  -- 回覆的對象必須是同一張畫上的留言
  if new.reply_to is not null and not exists (
    select 1 from public.drawing_comments p where p.id = new.reply_to and p.drawing_id = new.drawing_id
  ) then
    raise exception 'invalid reply target';
  end if;
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


-- ── 5b. 通知（有人回覆你的留言、有人戳你）───────────────────────────
--  • 用戶端只能讀自己的通知、把 read_at 標成已讀、刪除；「不能」自己新增通知。
--  • 通知只會由資料庫裡 security definer 的程式建立：
--      - 留言觸發器（回覆別人的留言 → 通知被回覆的人，回覆自己不通知）
--      - poke_friend()（戳好友）
--  • 超過 30 天的通知由 purge_expired() 清掉。
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  recipient  uuid not null references public.profiles (id) on delete cascade,
  actor      uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('reply', 'poke')),
  drawing_id uuid,
  comment_id uuid,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index if not exists notifications_recipient_idx on public.notifications (recipient, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notifications: read own" on public.notifications;
create policy "notifications: read own" on public.notifications
  for select to authenticated using (recipient = (select auth.uid()));

drop policy if exists "notifications: update own" on public.notifications;
create policy "notifications: update own" on public.notifications
  for update to authenticated
  using (recipient = (select auth.uid()))
  with check (recipient = (select auth.uid()));

drop policy if exists "notifications: delete own" on public.notifications;
create policy "notifications: delete own" on public.notifications
  for delete to authenticated using (recipient = (select auth.uid()));

-- 刻意沒有 insert policy，也不給 insert 權限
revoke all on public.notifications from public, anon, authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;   -- 只能改已讀時間，不能改收件人或種類

-- 有人回覆留言 → 通知被回覆的人（回覆自己不通知）
create or replace function public.notify_comment_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_author uuid;
begin
  if new.reply_to is null then
    return new;
  end if;
  select c.author into parent_author from public.drawing_comments c where c.id = new.reply_to;
  if parent_author is not null and parent_author <> new.author then
    insert into public.notifications (recipient, actor, kind, drawing_id, comment_id)
    values (parent_author, new.author, 'reply', new.drawing_id, new.id);
  end if;
  return new;
end;
$$;

revoke execute on function public.notify_comment_reply() from public, anon;

drop trigger if exists drawing_comments_notify on public.drawing_comments;
create trigger drawing_comments_notify
  after insert on public.drawing_comments
  for each row execute function public.notify_comment_reply();

-- 戳好友的紀錄：只用來做頻率限制（收件人刪掉通知也不影響）。沒有任何人（除了函式）能讀寫。
create table if not exists public.poke_log (
  actor      uuid not null references public.profiles (id) on delete cascade,
  recipient  uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists poke_log_pair_idx on public.poke_log (actor, recipient, created_at desc);
alter table public.poke_log enable row level security;
revoke all on public.poke_log from public, anon, authenticated;

-- 戳好友：只能戳「已經是好友」的人；同一對人 12 小時內最多戳一次。
-- 回傳 'ok' | 'not_friends' | 'too_soon'
create or replace function public.poke_friend(target uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not signed in';
  end if;
  if target is null or target = me then
    return 'not_friends';
  end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and ((f.requester = me and f.addressee = target) or (f.requester = target and f.addressee = me))
  ) then
    return 'not_friends';
  end if;
  -- 同一對人同時戳也只算一次
  perform pg_advisory_xact_lock(hashtextextended(me::text || ':' || target::text, 0));
  if exists (
    select 1 from public.poke_log l
     where l.actor = me and l.recipient = target
       and l.created_at > now() - interval '12 hours'
  ) then
    return 'too_soon';
  end if;
  insert into public.poke_log (actor, recipient) values (me, target);
  insert into public.notifications (recipient, actor, kind) values (target, me, 'poke');
  return 'ok';
end;
$$;

revoke execute on function public.poke_friend(uuid) from public, anon;
grant execute on function public.poke_friend(uuid) to authenticated;


-- ── 5c. 許願池 ──────────────────────────────────────────────────
--  • 使用者可以許願新功能（最多 500 字）；只有許願的人自己看得到、刪得掉自己的願望。
--  • 24 小時內每人最多 10 個願望。
--  • 網站管理員：Dashboard → Table Editor → wishes，
--    或在 SQL Editor 執行  select * from wishes_with_author order by created_at desc;
create table if not exists public.wishes (
  id         uuid primary key default gen_random_uuid(),
  author     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists wishes_author_idx on public.wishes (author, created_at desc);

alter table public.wishes enable row level security;

drop policy if exists "wishes: insert own" on public.wishes;
create policy "wishes: insert own" on public.wishes
  for insert to authenticated with check (author = (select auth.uid()));

drop policy if exists "wishes: read own" on public.wishes;
create policy "wishes: read own" on public.wishes
  for select to authenticated using (author = (select auth.uid()));

drop policy if exists "wishes: delete own" on public.wishes;
create policy "wishes: delete own" on public.wishes
  for delete to authenticated using (author = (select auth.uid()));

revoke all on public.wishes from public, anon, authenticated;
grant select, insert, delete on public.wishes to authenticated;   -- 沒有 update

create or replace function public.guard_wish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.body := btrim(new.body);
  new.created_at := now();
  if (select count(*) from public.wishes w
       where w.author = new.author and w.created_at > now() - interval '24 hours') >= 10 then
    raise exception 'wish limit reached';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_wish() from public, anon;

drop trigger if exists wishes_guard on public.wishes;
create trigger wishes_guard
  before insert on public.wishes
  for each row execute function public.guard_wish();

-- 給網站管理員看的檢視（附上許願的人）。只有 Dashboard／service role（資料庫擁有者）讀得到，
-- App 的使用者（anon、authenticated）完全不能讀。
create or replace view public.wishes_with_author as
  select w.id, w.created_at, w.body, p.username, p.display_name, w.author
    from public.wishes w
    left join public.profiles p on p.id = w.author;

revoke all on public.wishes_with_author from public, anon, authenticated;


-- ── 5d. 打氣區 ──────────────────────────────────────────────────
--  • 所有登入的使用者都看得到大家的打氣留言（不限好友），每則最多 200 字，只保留 3 天。
--  • 只有本人可以編輯（只能改內容 body）或刪除自己的留言；編輯不會延長 3 天的期限。
--  • 24 小時內每人最多 20 則。過期的留言 RLS 就讀不到，並由 purge_expired() 清掉。
--  • 網站管理員移除不適當的留言：SQL Editor 執行  select public.admin_delete_cheer('留言id');
--    或  delete from public.cheers where id = '留言id';（Dashboard → Table Editor → cheers 也可以）
create table if not exists public.cheers (
  id         uuid primary key default gen_random_uuid(),
  author     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  expires_at timestamptz not null default now() + interval '3 days'
);

create index if not exists cheers_expires_idx on public.cheers (expires_at desc);
create index if not exists cheers_created_idx on public.cheers (created_at desc);
create index if not exists cheers_author_idx on public.cheers (author, created_at desc);

alter table public.cheers enable row level security;

drop policy if exists "cheers: read live" on public.cheers;
create policy "cheers: read live" on public.cheers
  for select to authenticated using (expires_at > now());

drop policy if exists "cheers: insert own" on public.cheers;
create policy "cheers: insert own" on public.cheers
  for insert to authenticated with check (author = (select auth.uid()));

drop policy if exists "cheers: update own" on public.cheers;
create policy "cheers: update own" on public.cheers
  for update to authenticated
  using (author = (select auth.uid()) and expires_at > now())
  with check (author = (select auth.uid()));

drop policy if exists "cheers: delete own" on public.cheers;
create policy "cheers: delete own" on public.cheers
  for delete to authenticated using (author = (select auth.uid()));

revoke all on public.cheers from public, anon, authenticated;
grant select, insert, delete on public.cheers to authenticated;
grant update (body) on public.cheers to authenticated;      -- 只能改內容

create or replace function public.guard_cheer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.body := btrim(new.body);
    new.created_at := now();
    new.expires_at := now() + interval '3 days';
    new.updated_at := null;
    if (select count(*) from public.cheers c
         where c.author = new.author and c.created_at > now() - interval '24 hours') >= 20 then
      raise exception 'cheer limit reached';
    end if;
  else
    if new.author is distinct from old.author
       or new.created_at is distinct from old.created_at
       or new.expires_at is distinct from old.expires_at then
      raise exception 'cheer fields are read-only';
    end if;
    new.body := btrim(new.body);
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_cheer() from public, anon;

drop trigger if exists cheers_guard on public.cheers;
drop trigger if exists cheers_guard_ins on public.cheers;
drop trigger if exists cheers_guard_upd on public.cheers;
create trigger cheers_guard_ins
  before insert on public.cheers
  for each row execute function public.guard_cheer();
create trigger cheers_guard_upd
  before update on public.cheers
  for each row execute function public.guard_cheer();


-- ── 6. 自動清除過期資料 ──────────────────────────────────────────
-- 只清過期的畫、過期的文字、過期的打氣留言與 30 天前的通知；留言（drawing_comments）刻意不清，畫的主人要永遠看得到。
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
  delete from public.notifications where created_at < now() - interval '30 days';
  delete from public.poke_log where created_at < now() - interval '2 days';
  delete from public.cheers where expires_at <= now();
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

-- ============================================================
-- 8. 管理員工具：幫使用者救援帳號（只有 Supabase 後台的 SQL Editor 能用）
-- ============================================================
-- 這三個函式「不能」從網站呼叫：下面明確收回了 public／anon／authenticated 的執行權限，
-- 只有登入 Supabase Dashboard、在 SQL Editor（角色 postgres）執行的人才跑得動。
-- 網站（含已登入的使用者）呼叫會得到 permission denied。
--
-- 用法（在 Supabase → SQL Editor 貼上執行，把 xxx 換掉）：
--
--   -- 1. 不確定對方的 ID 時：用 ID 或暱稱的一部分搜尋（最多 50 筆）
--   select * from public.admin_find_users('xxx');
--
--   -- 2. 看某個帳號為什麼登入不了（登入用的信箱、信箱有沒有確認、問題是否被鎖住…）
--   select * from public.admin_user_status('momo_draws');
--
--   -- 3. 幫對方重設成臨時密碼（至少 6 個字元），再請對方登入後到「我的 → 修改密碼」自己改掉
--   select public.admin_reset_password('momo_draws', '臨時密碼123');
--
-- admin_reset_password 同時會：把尚未確認的信箱標成已確認、清除「忘記密碼」答錯的紀錄（解除鎖定）、
-- 把登入信箱改成 ID 信箱（舊的真實信箱不再使用）、並讓舊的登入失效。
-- 注意：SQL Editor 會保留執行過的語句，臨時密碼用完就請對方改掉。
--
--   -- 4. 把「早期用真實 email 註冊」的帳號一次全部改成用 ID 登入（密碼不變；不會自動執行，要自己呼叫）
--   --    沒有任何資料列 = 全部都已經正常；可以重複執行
--   select * from public.admin_migrate_email_logins();

-- 回傳欄位變了（多了 id_login_ok），所以要先 drop 再建立
drop function if exists public.admin_user_status(text);

create function public.admin_user_status(p_username text)
returns table (
  username text,
  display_name text,
  user_id uuid,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  login_email text,
  email_confirmed boolean,
  has_recovery_answers boolean,
  recovery_failures_24h integer,
  recovery_locked boolean,
  id_login_ok boolean
)
language sql
security definer
set search_path = ''
as $$
  select p.username, p.display_name, p.id, u.created_at, u.last_sign_in_at, u.email::text,
         (u.email_confirmed_at is not null),
         exists (select 1 from public.recovery_answers r where r.user_id = p.id),
         f.n,
         f.n >= 5,
         (lower(u.email) = p.username || '@users.art-day.invalid')
    from public.profiles p
    left join auth.users u on u.id = p.id
    cross join lateral (
      select count(*)::integer as n from public.recovery_attempts a
       where a.user_id = p.id and not a.success and a.attempted_at > now() - interval '24 hours'
    ) f
   where p.username = lower(regexp_replace(btrim(coalesce(p_username, '')), '^@', ''));
$$;

create or replace function public.admin_find_users(p_query text)
returns table (
  username text,
  display_name text,
  user_id uuid,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  login_email text,
  email_confirmed boolean,
  has_recovery_answers boolean,
  recovery_locked boolean
)
language sql
security definer
set search_path = ''
as $$
  select p.username, p.display_name, p.id, u.created_at, u.last_sign_in_at, u.email::text,
         (u.email_confirmed_at is not null),
         exists (select 1 from public.recovery_answers r where r.user_id = p.id),
         (select count(*) from public.recovery_attempts a
           where a.user_id = p.id and not a.success and a.attempted_at > now() - interval '24 hours') >= 5
    from public.profiles p
    left join auth.users u on u.id = p.id
   where btrim(coalesce(p_query, '')) <> ''
     and (p.username ilike '%' || replace(replace(replace(lower(regexp_replace(btrim(p_query), '^@', '')), '\', '\\'), '%', '\%'), '_', '\_') || '%'
       or p.display_name ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
   order by p.username
   limit 50;
$$;

-- 內部helper：把某個使用者的登入信箱改成「<ID>@users.art-day.invalid」，密碼不動。
-- 回傳 'unchanged'（本來就正常）、'skipped: email in use'、或 'ok'；其他錯誤直接 raise。
-- 呼叫者要自己用 begin/exception 包住。不能從網站呼叫（見最下面的 revoke）。
create or replace function public.admin_fix_login_email(p_uid uuid, p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target text := lower(p_username) || '@users.art-day.invalid';
  old_email text;
begin
  select u.email into old_email from auth.users u where u.id = p_uid;
  if not found then
    raise exception 'auth.users 裡找不到 %', p_uid;
  end if;
  if lower(coalesce(old_email, '')) = target then
    return 'unchanged';
  end if;
  if exists (select 1 from auth.users x where lower(x.email) = target and x.id <> p_uid) then
    return 'skipped: email in use';
  end if;

  update auth.users
     set email = target,
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = p_uid;

  -- 清掉還沒完成的「換信箱」請求（欄位不存在就略過）
  begin update auth.users set email_change = '' where id = p_uid;
  exception when undefined_column then null; end;
  begin update auth.users set email_change_token_new = '' where id = p_uid;
  exception when undefined_column then null; end;
  begin update auth.users set email_change_token_current = '' where id = p_uid;
  exception when undefined_column then null; end;
  begin update auth.users set email_change_confirm_status = 0 where id = p_uid;
  exception when undefined_column then null; end;

  -- email 身分：identity_data 改成新信箱。
  -- 注意 auth.identities.email 是 generated column，不能直接寫入，會跟著 identity_data 自動更新。
  begin
    update auth.identities
       set identity_data = identity_data || jsonb_build_object('email', target, 'email_verified', true),
           updated_at = now()
     where user_id = p_uid and provider = 'email';
  exception when undefined_table or undefined_column then null; end;
  -- 舊格式的 provider_id 是信箱，新格式是 user id；舊格式的改成 user id
  begin
    update auth.identities
       set provider_id = p_uid::text
     where user_id = p_uid and provider = 'email'
       and lower(provider_id) = lower(old_email);
  exception when undefined_table or undefined_column then null; end;

  -- 讓舊的登入失效（資料表不存在或沒權限時略過）
  begin delete from auth.refresh_tokens where user_id = p_uid::text;
  exception when others then null; end;
  begin delete from auth.sessions where user_id = p_uid;
  exception when others then null; end;

  return 'ok';
end;
$$;

create or replace function public.admin_migrate_email_logins()
returns table (username text, old_email text, new_email text, result text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  res text;
begin
  for r in
    select p.id as uid, p.username as uname, u.email::text as email
      from public.profiles p
      join auth.users u on u.id = p.id
     where lower(coalesce(u.email, '')) <> lower(p.username) || '@users.art-day.invalid'
     order by p.username
  loop
    username := r.uname;
    old_email := r.email;
    new_email := lower(r.uname) || '@users.art-day.invalid';
    begin
      res := public.admin_fix_login_email(r.uid, r.uname);
      result := case when res = 'unchanged' then 'ok' else res end;
    exception when others then
      result := 'error: ' || sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

create or replace function public.admin_reset_password(p_username text, p_new_password text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uname text := lower(regexp_replace(btrim(coalesce(p_username, '')), '^@', ''));
  uid uuid;
  n integer;
  old_email text;
  fixed text;
  note text := '';
begin
  select p.id into uid from public.profiles p where p.username = uname;
  if uid is null then
    raise exception '找不到使用者 @%（請用 admin_find_users 搜尋確認 ID）', uname;
  end if;
  if char_length(coalesce(p_new_password, '')) < 6 then
    raise exception '新密碼至少需要 6 個字元';
  end if;

  begin
    update auth.users
       set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = uid;
    get diagnostics n = row_count;
  exception when others then
    raise exception '無法更新 auth.users（%）。請確認是在 Supabase SQL Editor（postgres 角色）執行', sqlerrm;
  end;
  if n = 0 then
    raise exception '@% 有檔案，但 auth.users 裡找不到對應的帳號', uname;
  end if;

  -- 把登入信箱也改成 ID 信箱（舊的真實信箱不再使用）
  select u.email::text into old_email from auth.users u where u.id = uid;
  begin
    fixed := public.admin_fix_login_email(uid, uname);
  exception when others then
    fixed := 'error: ' || sqlerrm;
  end;
  if fixed = 'ok' then
    note := ' (login switched from ' || coalesce(old_email, 'none') || ' to ID)';
  elsif fixed <> 'unchanged' then
    note := ' (WARNING: login email not changed - ' || fixed || ')';
  end if;

  -- 清除「忘記密碼」答錯的紀錄（解除鎖定）
  begin
    delete from public.recovery_attempts where user_id = uid and not success;
  exception when others then
    null;
  end;
  -- 讓舊的登入失效（資料表不存在或沒權限時略過）
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

  return 'ok: password reset for @' || uname || note;
end;
$$;

-- Supabase 預設會把新函式的執行權限給 anon／authenticated，所以一定要明確收回；不授權給任何人。
revoke execute on function public.admin_user_status(text) from public, anon, authenticated;
revoke execute on function public.admin_find_users(text) from public, anon, authenticated;
revoke execute on function public.admin_reset_password(text, text) from public, anon, authenticated;
revoke execute on function public.admin_fix_login_email(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_migrate_email_logins() from public, anon, authenticated;

-- 打氣區：管理員刪除不適當的留言（同樣只有 SQL Editor 能用）
--   select public.admin_delete_cheer('留言id');   -- 留言 id 可在 Table Editor → cheers 找到
create or replace function public.admin_delete_cheer(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.cheers where id = p_id;
  get diagnostics n = row_count;
  return case when n > 0 then 'ok: cheer deleted' else 'not found' end;
end;
$$;

revoke execute on function public.admin_delete_cheer(uuid) from public, anon, authenticated;
