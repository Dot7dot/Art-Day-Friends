// 雲端模式：使用 Supabase（免費方案即可）
// 資料表與安全規則見 supabase/schema.sql

const LIB = '../vendor/supabase-js-2.117.3.mjs';

const ERRORS = [
  [/invalid login credentials/i, 'Email 或密碼不正確'],
  [/email not confirmed/i, '請先到信箱點擊確認信，再回來登入'],
  [/user already registered/i, '這個 Email 已經註冊過了，請直接登入'],
  [/password should be at least/i, '密碼至少需要 6 個字元'],
  [/unable to validate email|invalid email|email address .* is invalid/i, 'Email 格式不正確'],
  [/rate limit|too many requests|security purposes/i, '操作太頻繁了，請稍等一下再試'],
  [/database error saving new user/i, '註冊失敗：使用者 ID 可能已被使用'],
  [/daily cloud limit/i, '今天上傳到雲端的張數已達上限'],
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

const mapProfile = (p) => p && { id: p.id, username: p.username, displayName: p.display_name };

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

  async function doSignUp({ email, password, username, displayName }) {
    const data = check(await sb.auth.signUp({
      email,
      password,
      options: {
        data: { username: username.toLowerCase(), display_name: displayName },
        emailRedirectTo: location.origin + location.pathname,
      },
    }));
    if (!data.session) return { needsConfirm: true };
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

    /** 登入狀態從別處改變時（例如點了確認信、登入過期）通知 App */
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

    async signUp({ email, password, username, displayName }) {
      authBusy = true;
      try {
        return await doSignUp({ email, password, username, displayName });
      } finally { authBusy = false; }
    },

    async signIn({ login, password }) {
      authBusy = true;
      try {
        const data = check(await sb.auth.signInWithPassword({ email: login.trim(), password }));
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
      check(await sb.from('drawings').delete().eq('id', id).eq('user_id', me.id));
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
