// 雲端模式：使用 Supabase（免費方案即可）
// 資料表與安全規則見 supabase/schema.sql

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

const COMMENT_COLS = 'id, drawing_id, day, body, created_at, author';
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const mapProfile = (p) => p && { id: p.id, username: p.username, displayName: p.display_name };

const mapComment = (r, author) => ({
  id: r.id, drawingId: r.drawing_id, day: r.day, body: r.body, createdAt: r.created_at,
  author: author || { id: r.author, username: '', displayName: '已離開的朋友' },
});

export async function createSupabaseBackend(url, anonKey) {
  const { createClient } = await import(LIB);
  const sb = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'artday-auth' },
  });

  let me = null;
  let authBusy = false; // 自己正在登入／註冊時，不重複處理登入事件
  const imageCache = new Map();

  async function loadProfile(user) {
    let p = check(await sb.from('profiles').select('id, username, display_name').eq('id', user.id).maybeSingle());
    if (!p) {
      // 萬一資料庫觸發器沒建立 profile，這裡補建
      const meta = user.user_metadata || {};
      const username = /^[a-z0-9_]{3,20}$/.test(meta.username || '') ? meta.username : `artist_${user.id.replace(/-/g, '').slice(0, 8)}`;
      p = check(await sb.from('profiles')
        .insert({ id: user.id, username, display_name: (meta.display_name || username).slice(0, 30) })
        .select('id, username, display_name').single());
    }
    return mapProfile(p);
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
        // 一般輸入使用者 ID；含有 @ 的（例如早期用 email 註冊的帳號）就直接當 email 用
        const id = login.trim().replace(/^@/, '');
        const email = id.includes('@') ? id : loginEmail(id);
        const data = check(await sb.auth.signInWithPassword({ email, password }));
        me = await loadProfile(data.user);
        return me;
      } finally { authBusy = false; }
    },

    async signOut() {
      me = null;
      await sb.auth.signOut();
    },

    async updateProfile({ displayName }) {
      const p = check(await sb.from('profiles').update({ display_name: displayName }).eq('id', me.id)
        .select('id, username, display_name').single());
      me = mapProfile(p);
      return me;
    },

    async findUser(username) {
      const p = check(await sb.from('profiles').select('id, username, display_name')
        .eq('username', username.toLowerCase()).neq('id', me.id).maybeSingle());
      return mapProfile(p);
    },

    async searchUsers(q) {
      const safe = q.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_/g, '\\_');
      if (!safe) return [];
      const rows = check(await sb.from('profiles').select('id, username, display_name')
        .ilike('username', `%${safe}%`).neq('id', me.id).order('username').limit(20));
      return rows.map(mapProfile);
    },

    async listFriendships() {
      const rows = check(await sb.from('friendships').select('requester, addressee, status'));
      const otherIds = [...new Set(rows.map((r) => (r.requester === me.id ? r.addressee : r.requester)))];
      const profiles = otherIds.length
        ? check(await sb.from('profiles').select('id, username, display_name').in('id', otherIds))
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
        rows.push(...check(await sb.from('drawing_comments').select(COMMENT_COLS)
          .in('drawing_id', part).order('created_at').limit(1000)));
      }
      const authorIds = [...new Set(rows.map((r) => r.author))];
      const byId = new Map();
      for (const part of chunk(authorIds, 80)) {
        for (const p of check(await sb.from('profiles').select('id, username, display_name').in('id', part))) byId.set(p.id, mapProfile(p));
      }
      return rows.map((r) => mapComment(r, byId.get(r.author)));
    },

    async addComment(drawingId, body) {
      const { data, error } = await sb.from('drawing_comments').insert({ drawing_id: drawingId, body })
        .select(COMMENT_COLS).single();
      if (error) {
        if (error.code === '42501') throw Object.assign(new Error('只有好友可以在今天的畫上留言'), { cause: error });
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

    async fetchDrawingImage(id) {
      if (imageCache.has(id)) return imageCache.get(id);
      const row = check(await sb.from('drawings').select('image').eq('id', id).maybeSingle());
      if (!row) throw new Error('這張畫已經不在雲端了');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(row.image)) throw new Error('圖片格式不正確');
      imageCache.set(id, row.image);
      return row.image;
    },

    async fetchFriendsToday() {
      const { friends } = await api.listFriendships();
      if (!friends.length) return [];
      const ids = friends.map((f) => f.id);
      const now = new Date().toISOString();
      const [drawings, notes] = await Promise.all([
        sb.from('drawings').select('id, user_id, width, height, created_at').in('user_id', ids).gt('expires_at', now).order('created_at'),
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
          drawings: mine.map((d) => ({ id: d.id, width: d.width, height: d.height, createdAt: d.created_at })),
          note: note?.note || '',
          lastAt: times[times.length - 1] || null,
        };
      });
    },

    /** 把自己「今天以前」的雲端副本刪掉，並順手清掉所有人已過期的資料 */
    async purgeMyPast(today) {
      await Promise.all([
        sb.from('drawings').delete().eq('user_id', me.id).lt('day', today),
        sb.from('day_notes').delete().eq('user_id', me.id).lt('day', today),
        sb.rpc('purge_expired'),
      ]);
    },
  };
  return api;
}
