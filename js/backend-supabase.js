// 雲端模式：使用 Supabase（免費方案即可）
// 資料表與安全規則見 supabase/schema.sql

import { MSG } from './recovery.js';
import { getImageBlob, maintain as maintainImageCache, clear as clearImageCache } from './image-cache.js';
import { dataURLToBlob } from './imaging.js';

const LIB = '../vendor/supabase-js-2.117.3.mjs';

// 註冊不需要信箱：Supabase 登入一定要有 email 欄位，所以用「使用者 ID」組出一個
// 收不到信的內部帳號（.invalid 是保留網域，不會寄出、也不屬於任何人）。
// Supabase 必須關閉「Confirm email」，見 README。注意：這個網域改了，舊帳號就登入不了。
const LOGIN_DOMAIN = 'users.art-day.invalid';
const loginEmail = (username) => `${username.trim().replace(/^@/, '').toLowerCase()}@${LOGIN_DOMAIN}`;
const NEEDS_AUTOCONFIRM = '雲端設定還差一步：請在 Supabase → Authentication → Sign In / Providers → Email 關閉「Confirm email」';

const ERRORS = [
  [/invalid login credentials/i, '使用者 ID 或密碼不正確'],
  [/email not confirmed|email address .* is invalid|email_address_invalid|error sending confirmation/i, NEEDS_AUTOCONFIRM],
  [/user already registered/i, '這個使用者 ID 已經有人用了，換一個吧'],
  [/password should be at least/i, '密碼至少需要 6 個字元'],
  [/signups? not allowed/i, '目前沒有開放註冊'],
  [/rate limit|too many requests|security purposes/i, '操作太頻繁了，請稍等一下再試'],
  [/database error saving new user/i, '註冊失敗：使用者 ID 可能已被使用'],
  [/daily cloud limit/i, '今天上傳到雲端的張數已達上限'],
  [/drawing is not live/i, '這張畫已經過了今天，不能再留言了'],
  [/cheer limit/i, '24 小時內最多留 20 則打氣，明天再來吧'],
  [/wish limit/i, '24 小時內最多許 10 個願望，明天再來許吧'],
  [/invalid reply target|violates foreign key.*reply_to/i, '你要回覆的那則留言已經不見了'],
  [/comment limit/i, '你在這張畫上的留言已經太多了，先到這裡吧'],
  [/schema cache|does not exist|PGRST20[25]|42P01|42883/i, '雲端資料庫還沒設定完成：請先在 Supabase 執行 supabase/schema.sql'],
  [/invalid api key|no api key/i, '雲端金鑰不正確，請檢查 js/config.js'],
  [/failed to fetch|networkerror|load failed/i, '無法連線到雲端，請檢查網路'],
  [/jwt expired|invalid jwt/i, '登入已過期，請重新登入'],
];

function friendly(error) {
  const msg = error?.message || String(error);
  for (const [re, text] of ERRORS) if (re.test(msg)) return Object.assign(new Error(text), { cause: error, code: error?.code });
  return Object.assign(new Error(msg), { cause: error, code: error?.code });
}

function check({ data, error }) {
  if (error) throw friendly(error);
  return data;
}

// 資料庫還沒執行最新 schema.sql（找不到函式）
const isMissingFn = (e) => /PGRST20[25]|42883|42P01|schema cache|does not exist/i.test(`${e?.code || ''} ${e?.cause?.code || ''} ${e?.cause?.message || e?.message || ''}`);
const RECOVERY_UNSUPPORTED = Object.assign(new Error(MSG.unsupported), { code: 'RECOVERY_UNSUPPORTED' });

const COMMENT_COLS = 'id, drawing_id, day, body, created_at, author';
// 資料庫還沒更新（沒有 reply_to 欄位）時退回不含 reply_to 的欄位，並記住（本次使用期間）
const COMMENT_COLS_REPLY = `${COMMENT_COLS}, reply_to`;

// 資料表／欄位／函式還沒建立（還沒重新執行最新的 schema.sql）
const isMissingSchema = (e) => !!e && (/^(42P01|42703|42883|PGRST202|PGRST204|PGRST205)$/.test(e.code || e.cause?.code || '')
  || /schema cache|does not exist|could not find/i.test(e.message || e.cause?.message || ''));
const FEATURE_UNSUPPORTED = (what) => Object.assign(
  new Error(`${what}還沒開啟：請網站管理員到 Supabase SQL Editor 重新執行最新的 supabase/schema.sql`),
  { code: 'FEATURE_UNSUPPORTED' },
);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// sharePublic：自己的檔案才會查這個欄位（別人的不查）。null = 資料庫還沒有這個欄位（還沒更新 schema.sql）
const mapProfile = (p) => p && {
  id: p.id, username: p.username, displayName: p.display_name, avatar: p.avatar || null,
  ...('share_public' in p ? { sharePublic: p.share_public } : {}),
};

// 資料庫還沒執行最新 schema.sql（profiles 沒有 avatar 欄位）：42703 = 欄位不存在，PGRST204 = PostgREST 找不到欄位
const isMissingAvatarCol = (e) => !!e && /avatar/i.test(e.message || '')
  && (/^(42703|PGRST204)$/.test(e.code || '') || /column|schema cache/i.test(e.message || ''));
// 同上：profiles 沒有 share_public 欄位（推薦貼文還沒開啟）
const isMissingShareCol = (e) => !!e && /share_public/i.test(e.message || '')
  && (/^(42703|PGRST204)$/.test(e.code || '') || /column|schema cache/i.test(e.message || ''));
const SHARE_UNSUPPORTED = Object.assign(
  new Error('推薦功能還沒開啟：請網站管理員到 Supabase SQL Editor 重新執行最新的 supabase/schema.sql'),
  { code: 'SHARE_UNSUPPORTED' },
);
const AVATAR_UNSUPPORTED = Object.assign(
  new Error('大頭貼功能還沒開啟：請網站管理員到 Supabase SQL Editor 重新執行最新的 supabase/schema.sql'),
  { code: 'AVATAR_UNSUPPORTED' },
);

const mapComment = (r, author) => ({
  id: r.id, drawingId: r.drawing_id, day: r.day, body: r.body, createdAt: r.created_at, replyTo: r.reply_to || null,
  author: author || { id: r.author, username: '', displayName: '已離開的朋友' },
});

const CHEER_COLS = 'id, author, body, created_at, updated_at, expires_at';
const mapCheer = (r, author) => ({
  id: r.id, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at || null, expiresAt: r.expires_at,
  author: author || { id: r.author, username: '', displayName: '已離開的朋友' },
});

export async function createSupabaseBackend(url, anonKey) {
  const { createClient } = await import(LIB);
  const sb = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'artday-auth' },
  });

  let replyOk = true; // drawing_comments 有 reply_to 欄位嗎
  let me = null;
  let authBusy = false; // 自己正在登入／註冊時，不重複處理登入事件

  // 查個人檔案時一併取 avatar；資料庫還沒更新時退回不含 avatar 的查詢，並記住（本次使用期間）
  // self = 這是「我自己」的檔案：多查 share_public（推薦設定）；欄位不存在時同樣退回
  let avatarOk = true;
  let shareOk = true;
  const profileCols = (self) => ['id, username, display_name', avatarOk && 'avatar', self && shareOk && 'share_public'].filter(Boolean).join(', ');
  async function profileQuery(make, { self = false } = {}) {
    let res = await make(profileCols(self));
    for (let i = 0; i < 2 && res.error; i++) {
      if (avatarOk && isMissingAvatarCol(res.error)) avatarOk = false;
      else if (shareOk && isMissingShareCol(res.error)) shareOk = false;
      else break;
      res = await make(profileCols(self));
    }
    return check(res);
  }
  // 欄位不存在時，自己的檔案 sharePublic 為 null（畫面據此隱藏推薦的開關）
  const mapSelf = (p) => {
    const m = mapProfile(p);
    if (m && !('sharePublic' in m)) m.sharePublic = null;
    return m;
  };

  async function loadProfile(user) {
    let p = await profileQuery((cols) => sb.from('profiles').select(cols).eq('id', user.id).maybeSingle(), { self: true });
    if (!p) {
      // 萬一資料庫觸發器沒建立 profile，這裡補建
      const meta = user.user_metadata || {};
      const username = /^[a-z0-9_]{3,20}$/.test(meta.username || '') ? meta.username : `artist_${user.id.replace(/-/g, '').slice(0, 8)}`;
      p = await profileQuery((cols) => sb.from('profiles')
        .insert({ id: user.id, username, display_name: (meta.display_name || username).slice(0, 30) })
        .select(cols).single(), { self: true });
    }
    return mapSelf(p);
  }

  async function doSignUp({ password, username, displayName }) {
    const data = check(await sb.auth.signUp({
      email: loginEmail(username),
      password,
      options: { data: { username: username.toLowerCase(), display_name: displayName } },
    }));
    // 沒拿到登入狀態 = Supabase 還開著「Confirm email」
    if (!data.session) throw new Error(NEEDS_AUTOCONFIRM);
    me = await loadProfile(data.user);
    return { user: me };
  }

  const api = {
    mode: 'cloud',

    get me() { return me; },

    async init() {
      const { data, error } = await sb.auth.getSession();
      if (error) console.warn(error);
      me = data?.session ? await loadProfile(data.session.user) : null;
      maintainImageCache(); // 啟動時順手清掉過期的圖片快取（背景進行）
      return me;
    },

    /** 登入狀態從別處改變時（例如在別的分頁登出、登入過期）通知 App */
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((event, session) => {
        // 依官方建議，不在 callback 內直接呼叫其他 Supabase API
        setTimeout(async () => {
          if (authBusy) return;
          try {
            if (!session && me) { me = null; cb(null); }
            else if (session && (!me || me.id !== session.user.id)) { me = await loadProfile(session.user); cb(me); }
          } catch (e) { console.warn(e); }
        }, 0);
      });
    },

    async usernameAvailable(username) {
      return check(await sb.rpc('username_available', { name: username.toLowerCase() }));
    },

    async signUp({ password, username, displayName }) {
      authBusy = true;
      try {
        return await doSignUp({ password, username, displayName });
      } finally { authBusy = false; }
    },

    async signIn({ login, password }) {
      authBusy = true;
      try {
        // 一般輸入使用者 ID；含有 @ 的就直接當 email 用（舊帳號已改成 ID 登入，失敗時會提示改用 ID）
        const id = login.trim().replace(/^@/, '');
        const email = id.includes('@') ? id : loginEmail(id);
        const res = await sb.auth.signInWithPassword({ email, password });
        // 打了真實 email 卻登不進去：帳號已改成只用 ID 登入
        if (res.error && id.includes('@') && /invalid login credentials/i.test(res.error.message || '')) {
          throw Object.assign(new Error('現在請改用使用者 ID 登入（不用再輸入信箱）'), { cause: res.error, code: res.error.code });
        }
        const data = check(res);
        me = await loadProfile(data.user);
        return me;
      } finally { authBusy = false; }
    },

    /** 修改密碼：已登入就不用輸入舊密碼 */
    async changePassword(newPassword) {
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (!error) return;
      if (/different from the old/i.test(error.message)) throw new Error('新密碼不能和目前的密碼一樣');
      if (/at least|weak|short/i.test(error.message)) throw new Error('新密碼至少需要 6 個字元');
      throw friendly(error);
    },

    async signOut() {
      me = null;
      await sb.auth.signOut();
    },

    /** displayName、avatar（data URL，或 null 代表移除）、sharePublic（出現在推薦）都是選填，沒給的就不動 */
    async updateProfile({ displayName, avatar, sharePublic } = {}) {
      const patch = {};
      if (displayName !== undefined) patch.display_name = displayName;
      if (sharePublic !== undefined) {
        if (!shareOk) throw SHARE_UNSUPPORTED;
        patch.share_public = !!sharePublic;
      }
      if (avatar !== undefined) {
        if (!avatarOk) throw AVATAR_UNSUPPORTED;
        patch.avatar = avatar;
      }
      let p;
      try {
        p = await profileQuery((cols) => sb.from('profiles').update(patch).eq('id', me.id).select(cols).single(), { self: true });
      } catch (e) {
        if (avatar !== undefined && isMissingAvatarCol(e.cause)) { avatarOk = false; throw AVATAR_UNSUPPORTED; }
        if (sharePublic !== undefined && isMissingShareCol(e.cause)) { shareOk = false; throw SHARE_UNSUPPORTED; }
        throw e;
      }
      if (sharePublic !== undefined && !shareOk) throw SHARE_UNSUPPORTED; // 查詢途中才發現沒有欄位：更新並沒有生效
      me = mapSelf(p);
      return me;
    },

    // ── 忘記密碼的問題 ──

    /** { supported, hasAnswers, updatedAt }；資料庫還沒更新時 supported 為 false */
    async recoveryStatus() {
      try {
        const rows = check(await sb.rpc('recovery_status'));
        const r = Array.isArray(rows) ? rows[0] : rows;
        return { supported: true, hasAnswers: !!r?.has_answers, updatedAt: r?.updated_at || null };
      } catch (e) {
        if (isMissingFn(e)) return { supported: false, hasAnswers: false, updatedAt: null };
        throw e;
      }
    },

    async setRecoveryAnswers(animal, school) {
      const { error } = await sb.rpc('set_recovery_answers', { animal, school });
      if (!error) return;
      if (/invalid recovery animal/i.test(error.message)) throw new Error('請選擇最喜歡的動物');
      if (/invalid recovery school/i.test(error.message)) throw new Error('請填寫你畢業的國小');
      if (isMissingFn(error)) throw RECOVERY_UNSUPPORTED;
      throw friendly(error);
    },

    async clearRecoveryAnswers() {
      const { error } = await sb.rpc('clear_recovery_answers');
      if (error) throw isMissingFn(error) ? RECOVERY_UNSUPPORTED : friendly(error);
    },

    /** 這個使用者 ID 有沒有設定過問題（登入前使用） */
    async recoveryAvailable(username) {
      const { data, error } = await sb.rpc('recovery_available', { username: username.trim().replace(/^@/, '').toLowerCase() });
      if (error) throw isMissingFn(error) ? RECOVERY_UNSUPPORTED : friendly(error);
      return !!data;
    },

    /** 回傳 'ok' | 'wrong' | 'locked' | 'weak_password' */
    async resetPassword({ username, animal, school, newPassword }) {
      const { data, error } = await sb.rpc('reset_password_with_answers', {
        username: username.trim().replace(/^@/, '').toLowerCase(), animal, school, new_password: newPassword,
      });
      if (error) {
        if (isMissingFn(error)) throw RECOVERY_UNSUPPORTED;
        if (/failed to fetch|networkerror|load failed/i.test(error.message)) throw friendly(error);
        console.warn(error);
        throw Object.assign(new Error(MSG.resetFailed), { cause: error });
      }
      return String(data);
    },

    async findUser(username) {
      const p = await profileQuery((cols) => sb.from('profiles').select(cols)
        .eq('username', username.toLowerCase()).neq('id', me.id).maybeSingle());
      return mapProfile(p);
    },

    async searchUsers(q) {
      const safe = q.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_/g, '\\_');
      if (!safe) return [];
      const rows = await profileQuery((cols) => sb.from('profiles').select(cols)
        .ilike('username', `%${safe}%`).neq('id', me.id).order('username').limit(20));
      return rows.map(mapProfile);
    },

    async listFriendships() {
      const rows = check(await sb.from('friendships').select('requester, addressee, status'));
      const otherIds = [...new Set(rows.map((r) => (r.requester === me.id ? r.addressee : r.requester)))];
      const profiles = otherIds.length
        ? await profileQuery((cols) => sb.from('profiles').select(cols).in('id', otherIds))
        : [];
      const byId = new Map(profiles.map((p) => [p.id, mapProfile(p)]));
      const out = { friends: [], incoming: [], outgoing: [] };
      for (const r of rows) {
        const other = byId.get(r.requester === me.id ? r.addressee : r.requester);
        if (!other) continue;
        if (r.status === 'accepted') out.friends.push(other);
        else if (r.addressee === me.id) out.incoming.push(other);
        else out.outgoing.push(other);
      }
      for (const k of Object.keys(out)) out[k].sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'));
      return out;
    },

    async sendFriendRequest(targetId) {
      return check(await sb.rpc('send_friend_request', { target: targetId }));
    },

    /** 推薦好友：{ ...profile, mutualCount }；資料庫還沒更新（沒有這個函式）時丟出 code 'PGRST202' */
    async suggestFriends(limit = 8) {
      const rows = check(await sb.rpc('suggest_friends', { max_count: limit }));
      return (rows || []).map((r) => ({ ...mapProfile(r), mutualCount: r.mutual_count || 0 }));
    },

    /**
     * 推薦貼文：不是好友、同意公開分享、今天有畫的人，連同今天的畫（只有資料，圖片之後逐張載入）與文字。
     * 資料庫還沒更新（沒有 recommended_posts）時丟出錯誤（code PGRST202／42883），畫面就不顯示這一區。
     */
    async recommendedPosts(limit = 6) {
      const rows = check(await sb.rpc('recommended_posts', { max_count: limit })) || [];
      if (!rows.length) return [];
      const ids = rows.map((r) => r.user_id);
      const now = new Date().toISOString();
      const [drawings, notes] = await Promise.all([
        sb.from('drawings').select('id, user_id, width, height, created_at, expires_at').in('user_id', ids).gt('expires_at', now).order('created_at'),
        sb.from('day_notes').select('user_id, note, updated_at').in('user_id', ids).gt('expires_at', now).order('updated_at', { ascending: false }),
      ]);
      const ds = check(drawings);
      const ns = check(notes);
      return rows.map((r) => {
        const mine = ds.filter((d) => d.user_id === r.user_id);
        const note = ns.find((n) => n.user_id === r.user_id);
        const times = [...mine.map((d) => d.created_at), note?.updated_at].filter(Boolean).sort();
        return {
          profile: mapProfile({ id: r.user_id, username: r.username, display_name: r.display_name, avatar: r.avatar }),
          mutualCount: r.mutual_count || 0,
          drawings: mine.map((d) => ({ id: d.id, width: d.width, height: d.height, createdAt: d.created_at, expiresAt: d.expires_at })),
          note: note?.note || '',
          lastAt: times[times.length - 1] || r.last_at || null,
        };
      }).filter((p) => p.drawings.length);
    },

    async acceptFriend(otherId) {
      check(await sb.from('friendships').update({ status: 'accepted' })
        .eq('requester', otherId).eq('addressee', me.id));
    },

    async removeFriend(otherId) {
      check(await sb.from('friendships').delete()
        .or(`and(requester.eq.${me.id},addressee.eq.${otherId}),and(requester.eq.${otherId},addressee.eq.${me.id})`));
    },

    async uploadDrawing({ id, day, image, width, height, expiresAt }) {
      const { error } = await sb.from('drawings').insert({ id, user_id: me.id, day, image, width, height, expires_at: expiresAt });
      if (error && error.code !== '23505') throw friendly(error); // 23505 = 已經上傳過
    },

    async deleteDrawing(id) {
      // 留言跟著畫一起刪（畫的主人可以刪掉自己畫上的所有留言）；先刪留言，失敗就整個取消
      check(await sb.from('drawing_comments').delete().eq('drawing_id', id));
      check(await sb.from('drawings').delete().eq('id', id).eq('user_id', me.id));
    },

    // ── 留言（永久保存在雲端，不會跟著畫一起被清除）──

    /** 這些畫上看得到的留言（依時間由舊到新） */
    async fetchComments(drawingIds) {
      const ids = [...new Set(drawingIds)];
      if (!ids.length) return [];
      const rows = [];
      for (const part of chunk(ids, 40)) {
        const query = (cols) => sb.from('drawing_comments').select(cols).in('drawing_id', part).order('created_at').limit(1000);
        let res = await query(replyOk ? COMMENT_COLS_REPLY : COMMENT_COLS);
        if (res.error && replyOk && isMissingSchema(res.error)) { // 還沒有 reply_to 欄位：照舊查詢
          replyOk = false;
          res = await query(COMMENT_COLS);
        }
        rows.push(...check(res));
      }
      const authorIds = [...new Set(rows.map((r) => r.author))];
      const byId = new Map();
      for (const part of chunk(authorIds, 80)) {
        for (const p of await profileQuery((cols) => sb.from('profiles').select(cols).in('id', part))) byId.set(p.id, mapProfile(p));
      }
      return rows.map((r) => mapComment(r, byId.get(r.author)));
    },

    /** replyTo = 被回覆的留言 id（選填） */
    async addComment(drawingId, body, replyTo = null) {
      if (replyTo && !replyOk) throw FEATURE_UNSUPPORTED('回覆');
      const row = { drawing_id: drawingId, body };
      if (replyTo) row.reply_to = replyTo;
      const { data, error } = await sb.from('drawing_comments').insert(row)
        .select(replyOk ? COMMENT_COLS_REPLY : COMMENT_COLS).single();
      if (error) {
        if (error.code === '42501') throw Object.assign(new Error('只有好友可以在今天的畫上留言'), { cause: error });
        if (replyTo && isMissingSchema(error)) { replyOk = false; throw FEATURE_UNSUPPORTED('回覆'); }
        if (replyTo && error.code === '23503') throw Object.assign(new Error('你要回覆的那則留言已經不見了'), { cause: error });
        throw friendly(error);
      }
      return mapComment(data, me);
    },

    async deleteComment(id) {
      check(await sb.from('drawing_comments').delete().eq('id', id));
    },

    async saveNote({ day, note, expiresAt }) {
      if (note.trim()) {
        check(await sb.from('day_notes').upsert({ user_id: me.id, day, note, expires_at: expiresAt }, { onConflict: 'user_id,day' }));
      } else {
        check(await sb.from('day_notes').delete().eq('user_id', me.id).eq('day', day));
      }
    },

    async fetchMyToday(day) {
      const now = new Date().toISOString();
      const [drawings, note] = await Promise.all([
        sb.from('drawings').select('id, width, height, created_at').eq('user_id', me.id).eq('day', day).gt('expires_at', now).order('created_at'),
        sb.from('day_notes').select('note').eq('user_id', me.id).eq('day', day).gt('expires_at', now).maybeSingle(),
      ]);
      return {
        drawings: check(drawings).map((d) => ({ id: d.id, width: d.width, height: d.height, createdAt: d.created_at })),
        note: check(note)?.note || '',
      };
    },

    /**
     * 別人的畫的圖片（Blob）。順序：記憶體 → 裝置快取（IndexedDB）→ 網路；網路下載後會寫回快取。
     * 同一張圖同時被要求多次只會下載一次。自己的畫（user_id 是我）不寫入快取（本來就在本機 archive）。
     * 只有這個函式會查 drawings.image 欄位；其他查詢一律不選 image。
     */
    fetchDrawingBlob(id) {
      return getImageBlob(id, async () => {
        const row = check(await sb.from('drawings').select('image, user_id, expires_at').eq('id', id).maybeSingle());
        if (!row) throw new Error('這張畫已經不在雲端了');
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(row.image)) throw new Error('圖片格式不正確');
        return { blob: dataURLToBlob(row.image), expiresAt: row.expires_at, skipStore: row.user_id === me?.id };
      });
    },

    /** 裝置上的圖片快取：維護（刪過期／太舊／超量）與清除 */
    maintainImageCache,
    clearImageCache,

    async fetchFriendsToday() {
      const { friends } = await api.listFriendships();
      if (!friends.length) return [];
      const ids = friends.map((f) => f.id);
      const now = new Date().toISOString();
      const [drawings, notes] = await Promise.all([
        sb.from('drawings').select('id, user_id, width, height, created_at, expires_at').in('user_id', ids).gt('expires_at', now).order('created_at'),
        sb.from('day_notes').select('user_id, note, updated_at').in('user_id', ids).gt('expires_at', now).order('updated_at', { ascending: false }),
      ]);
      const ds = check(drawings);
      const ns = check(notes);
      return friends.map((p) => {
        const mine = ds.filter((d) => d.user_id === p.id);
        const note = ns.find((n) => n.user_id === p.id);
        const times = [...mine.map((d) => d.created_at), note?.updated_at].filter(Boolean).sort();
        return {
          profile: p,
          drawings: mine.map((d) => ({ id: d.id, width: d.width, height: d.height, createdAt: d.created_at, expiresAt: d.expires_at })),
          note: note?.note || '',
          lastAt: times[times.length - 1] || null,
        };
      });
    },

    // ── 許願池 ──

    /** 我自己許過的願望（新到舊）；資料庫還沒更新時丟出 code 'FEATURE_UNSUPPORTED' */
    async listWishes() {
      const { data, error } = await sb.from('wishes').select('id, body, created_at').order('created_at', { ascending: false }).limit(50);
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('許願池') : friendly(error);
      return (data || []).map((w) => ({ id: w.id, body: w.body, createdAt: w.created_at }));
    },

    async addWish(body) {
      const { data, error } = await sb.from('wishes').insert({ body }).select('id, body, created_at').single();
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('許願池') : friendly(error);
      return { id: data.id, body: data.body, createdAt: data.created_at };
    },

    // ── 打氣區（所有人的留言，保留 3 天）──

    /** 最近 3 天、還沒過期的打氣留言（新到舊）；資料庫還沒更新時丟出 code 'FEATURE_UNSUPPORTED' */
    async listCheers() {
      const { data, error } = await sb.from('cheers').select(CHEER_COLS)
        .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(200);
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('打氣區') : friendly(error);
      const rows = data || [];
      const byId = new Map();
      for (const part of chunk([...new Set(rows.map((r) => r.author))], 80)) {
        for (const p of await profileQuery((cols) => sb.from('profiles').select(cols).in('id', part))) byId.set(p.id, mapProfile(p));
      }
      return rows.map((r) => mapCheer(r, byId.get(r.author)));
    },

    async addCheer(body) {
      const { data, error } = await sb.from('cheers').insert({ body }).select(CHEER_COLS).single();
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('打氣區') : friendly(error);
      return mapCheer(data, me);
    },

    /** 只送 body；期限（expires_at）由資料庫固定，編輯不會延長 */
    async updateCheer(id, body) {
      const { data, error } = await sb.from('cheers').update({ body }).eq('id', id).select(CHEER_COLS).maybeSingle();
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('打氣區') : friendly(error);
      if (!data) throw new Error('這則打氣已經不見了（可能已過期或被刪除）');
      return mapCheer(data, me);
    },

    async deleteCheer(id) {
      const { error } = await sb.from('cheers').delete().eq('id', id);
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('打氣區') : friendly(error);
    },

    // ── 通知與戳好友 ──

    /** 還沒讀的通知數；資料庫還沒更新時丟出 code 'FEATURE_UNSUPPORTED' */
    async unreadNotificationCount() {
      const { count, error } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('通知') : friendly(error);
      return count || 0;
    },

    /** 我的通知（新到舊）：{ id, kind: 'reply'|'poke', actor, drawingId, commentId, createdAt, readAt, excerpt } */
    async listNotifications(limit = 30) {
      const { data, error } = await sb.from('notifications')
        .select('id, kind, actor, drawing_id, comment_id, created_at, read_at').order('created_at', { ascending: false }).limit(limit);
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('通知') : friendly(error);
      const rows = data || [];
      if (!rows.length) return [];
      const actorIds = [...new Set(rows.map((r) => r.actor))];
      const profiles = await profileQuery((cols) => sb.from('profiles').select(cols).in('id', actorIds));
      const byId = new Map(profiles.map((p) => [p.id, mapProfile(p)]));
      // 回覆的內容（看不到或已刪除就沒有摘要）
      const cids = [...new Set(rows.filter((r) => r.kind === 'reply' && r.comment_id).map((r) => r.comment_id))];
      const bodies = new Map();
      if (cids.length) {
        const res = await sb.from('drawing_comments').select('id, body').in('id', cids);
        if (!res.error) for (const c of res.data || []) bodies.set(c.id, c.body);
      }
      return rows.map((r) => ({
        id: r.id, kind: r.kind, drawingId: r.drawing_id, commentId: r.comment_id, createdAt: r.created_at, readAt: r.read_at,
        actor: byId.get(r.actor) || { id: r.actor, username: '', displayName: '已離開的朋友' },
        excerpt: bodies.get(r.comment_id) || '',
      }));
    },

    async markNotificationsRead() {
      const { error } = await sb.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('通知') : friendly(error);
    },

    /** 戳好友：回傳 'ok' | 'not_friends' | 'too_soon' */
    async pokeFriend(targetId) {
      const { data, error } = await sb.rpc('poke_friend', { target: targetId });
      if (error) throw isMissingSchema(error) ? FEATURE_UNSUPPORTED('戳好友') : friendly(error);
      return String(data);
    },

    /** 把自己「今天以前」的雲端副本刪掉，並順手清掉所有人已過期的資料 */
    async purgeMyPast(today) {
      await Promise.all([
        sb.from('drawings').delete().eq('user_id', me.id).lt('day', today),
        sb.from('day_notes').delete().eq('user_id', me.id).lt('day', today),
        sb.rpc('purge_expired'),
      ]);
      maintainImageCache();
    },
  };
  return api;
}
