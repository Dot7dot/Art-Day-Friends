// 本機示範模式：不需要任何伺服器。
// 帳號、好友與「共用雲端」都模擬在這台裝置的瀏覽器裡，並附上幾位示範好友。
// 規則與真正的雲端版一致：好友只看得到今天的畫，過了今天就從「雲端」移除。

import { openDB, promisify, run } from './idb.js';
import { dayKey, endOfDay } from './dates.js';
import { demoArt } from './demo-art.js';
import { recoverySecret, MAX_FAILED_ATTEMPTS } from './recovery.js';

const K_USERS = 'artday.demo.users';
const K_SESSION = 'artday.demo.session';
const K_FRIENDS = 'artday.demo.friendships';
const K_RECOVERY_FAILS = 'artday.demo.recoveryFails'; // { 使用者id: [答錯的時間（毫秒）] }
const K_CANNED = 'artday.demo.cannedComments'; // 示範好友已經留過言的畫（每張只留一次）

const DEMO_ARTISTS = [
  {
    id: 'demo-momo', username: 'momo_draws', displayName: '桃桃', themes: [1, 2],
    notes: ['今天用了新買的橘色代針筆，線條好順。', '下午的光很好，畫了窗邊的植物。', '只畫了十分鐘，但很開心。', '試著不打草稿直接畫！'],
    posts: () => true,
  },
  {
    id: 'demo-ashu', username: 'ashu_sketch', displayName: '阿樹', themes: [0, 3],
    notes: ['通勤時的速寫。', '今天的主題：圓形。', '畫畫是今天最安靜的時刻。', '顏色亂配也很可愛。'],
    posts: () => true,
  },
  {
    id: 'demo-lin', username: 'lin_doodle', displayName: '小林', themes: [3, 2],
    notes: ['補畫昨天想到的點子。', '今天畫得很慢，但很喜歡。'],
    posts: (day) => Number(day.slice(-2)) % 2 === 0,
  },
  {
    id: 'demo-nana', username: 'nana_paint', displayName: '娜娜', themes: [2, 1],
    notes: ['今天試了水彩暈染。', '用咖啡漬當底色，意外好看。', '小小的一張，慢慢畫。'],
    posts: () => true, // 每天都畫、也不會自動成為好友：用來示範「推薦貼文」
  },
  {
    id: 'demo-kai', username: 'kai_ink', displayName: '阿凱', themes: [0, 1],
    notes: ['黑色墨水加一點橘色。', '午休十分鐘塗鴉。'],
    posts: () => true,
  },
];

// 示範畫家彼此之間本來就是好友，這樣你加了其中一位之後，就會看到「共同好友」的推薦
const DEMO_LINKS = [
  ['demo-momo', 'demo-ashu'], ['demo-momo', 'demo-lin'], ['demo-momo', 'demo-nana'],
  ['demo-ashu', 'demo-lin'], ['demo-ashu', 'demo-nana'], ['demo-lin', 'demo-kai'],
];

const CANNED_COMMENTS = [
  '好喜歡這張的色彩！',
  '線條好有質感，今天也辛苦了～',
  '看了心情變好，謝謝你分享！',
  '這張好可愛，我要偷學一下構圖。',
  '好溫柔的畫，明天也想看到你的新作！',
];
const COMMENT_MAX = 200;
const COMMENT_CAP = 30;

const read = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function createLocalBackend() {
  const cloud = openDB('artday-demo-cloud', 2, (d, oldVersion) => {
    if (oldVersion < 1) {
      d.createObjectStore('drawings', { keyPath: 'id' }).createIndex('byUser', 'userId');
      d.createObjectStore('notes', { keyPath: ['userId', 'day'] });
    }
    // 留言不跟著畫一起清除（和真正的雲端版一樣）
    if (oldVersion < 2) d.createObjectStore('comments', { keyPath: 'id' }).createIndex('byDrawing', 'drawingId');
  });

  // 確保示範好友存在
  const users = read(K_USERS, []);
  for (const a of DEMO_ARTISTS) {
    if (!users.some((u) => u.id === a.id)) users.push({ id: a.id, username: a.username, displayName: a.displayName, demo: true, createdAt: `2024-01-0${DEMO_ARTISTS.indexOf(a) + 1}T00:00:00.000Z` });
  }
  write(K_USERS, users);
  {
    const list = read(K_FRIENDS, []);
    let changed = false;
    for (const [a, b] of DEMO_LINKS) {
      if (list.some((f) => (f.requester === a && f.addressee === b) || (f.requester === b && f.addressee === a))) continue;
      list.push({ requester: a, addressee: b, status: 'accepted', createdAt: '2024-01-01T00:00:00.000Z' });
      changed = true;
    }
    if (changed) write(K_FRIENDS, list);
  }

  let me = null;
  const allUsers = () => read(K_USERS, []);
  // 推薦設定：示範畫家預設都同意公開（demo）；一般使用者預設不公開，要自己開
  const profile = (u) => u && { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar || null, demo: !!u.demo, sharePublic: u.demo ? u.sharePublic !== false : !!u.sharePublic };
  const byId = (id) => profile(allUsers().find((u) => u.id === id));
  const friendships = () => read(K_FRIENDS, []);
  const nowIso = () => new Date().toISOString();

  async function ensureDemoPosts(day) {
    const expiresAt = endOfDay(day).toISOString();
    const n = Number(day.replaceAll('-', ''));
    for (const a of DEMO_ARTISTS) {
      if (!a.posts(day)) continue;
      const existing = await run(cloud, 'drawings', 'readonly', ({ drawings }) => promisify(drawings.index('byUser').getAll(a.id)));
      if (existing.some((d) => d.day === day)) continue;
      const count = 1 + (n % 2);
      const startOfDay = endOfDay(day).getTime() - 864e5;
      const base = Math.max(startOfDay + 60_000, Date.now() - 1000 * 60 * (40 + (n % 200)));
      await run(cloud, ['drawings', 'notes'], 'readwrite', ({ drawings, notes }) => {
        for (let i = 0; i < count; i++) {
          drawings.put({
            id: `${a.id}-${day}-${i}`, userId: a.id, day, width: 600, height: 600,
            image: demoArt(`${a.id}:${day}:${i}`, a.themes[(n + i) % a.themes.length]),
            createdAt: new Date(base + i * 1000 * 60 * 25).toISOString(), expiresAt,
          });
        }
        notes.put({ userId: a.id, day, note: a.notes[n % a.notes.length], updatedAt: new Date(base).toISOString(), expiresAt });
      });
    }
  }

  async function purgeExpired() {
    const now = nowIso();
    await run(cloud, ['drawings', 'notes'], 'readwrite', async ({ drawings, notes }) => {
      const [ds, ns] = await Promise.all([promisify(drawings.getAll()), promisify(notes.getAll())]);
      ds.filter((d) => d.expiresAt <= now).forEach((d) => drawings.delete(d.id));
      ns.filter((x) => x.expiresAt <= now).forEach((x) => notes.delete([x.userId, x.day]));
    });
  }

  const hashStr = (str) => [...str].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7);
  const getDrawing = (id) => run(cloud, 'drawings', 'readonly', ({ drawings }) => promisify(drawings.get(id)));
  const isFriend = (a, b) => friendships().some((f) => f.status === 'accepted'
    && ((f.requester === a && f.addressee === b) || (f.requester === b && f.addressee === a)));
  const pubComment = (c) => ({
    id: c.id, drawingId: c.drawingId, day: c.day, body: c.body, createdAt: c.createdAt,
    author: byId(c.author) || { id: c.author, username: '', displayName: '已離開的朋友' },
  });
  const putCloudComment = (c) => run(cloud, 'comments', 'readwrite', ({ comments }) => promisify(comments.put(c)));

  /** 示範：我的好友裡的示範畫家，會在我今天的每張畫上各留一句話（每張只留一次） */
  async function ensureCannedComments(drawings) {
    const artists = DEMO_ARTISTS.filter((a) => isFriend(a.id, me.id));
    if (!artists.length) return;
    const done = new Set(read(K_CANNED, []));
    for (const d of drawings) {
      if (done.has(d.id)) continue;
      const h = hashStr(d.id);
      const a = artists[h % artists.length];
      done.add(d.id);
      await putCloudComment({
        id: `demo-c-${d.id}`, drawingId: d.id, drawingOwner: me.id, author: a.id, day: d.day,
        body: CANNED_COMMENTS[(h >>> 3) % CANNED_COMMENTS.length], createdAt: nowIso(),
      });
    }
    write(K_CANNED, [...done]);
  }

  const api = {
    mode: 'local',

    async init() {
      const id = localStorage.getItem(K_SESSION);
      me = id ? byId(id) : null;
      return me;
    },

    onAuthChange() {},

    get me() { return me; },

    async usernameAvailable(username) {
      return !allUsers().some((u) => u.username === username.toLowerCase());
    },

    async signUp({ username, displayName, password, sharePublic = false }) {
      username = username.toLowerCase();
      if (!(await api.usernameAvailable(username))) throw new Error('這個使用者 ID 已經有人用了');
      const salt = randomHex(8);
      const user = { id: `u-${randomHex(8)}`, username, displayName, sharePublic: !!sharePublic, salt, hash: await sha256(`${salt}:${password}`), createdAt: nowIso() };
      write(K_USERS, [...allUsers(), user]);
      // 示範：桃桃主動送來好友邀請
      write(K_FRIENDS, [...friendships(), { requester: 'demo-momo', addressee: user.id, status: 'pending', createdAt: nowIso() }]);
      localStorage.setItem(K_SESSION, user.id);
      me = profile(user);
      return { user: me };
    },

    async signIn({ login, password }) {
      const u = allUsers().find((x) => x.username === login.trim().replace(/^@/, '').toLowerCase());
      if (!u || u.demo || u.hash !== (await sha256(`${u.salt}:${password}`))) throw new Error('使用者 ID 或密碼不正確');
      localStorage.setItem(K_SESSION, u.id);
      me = profile(u);
      return me;
    },

    async signOut() {
      localStorage.removeItem(K_SESSION);
      me = null;
    },

    /** displayName、avatar（data URL，或 null 代表移除）、sharePublic 都是選填，沒給的就不動 */
    async updateProfile({ displayName, avatar, sharePublic } = {}) {
      write(K_USERS, allUsers().map((u) => {
        if (u.id !== me.id) return u;
        const next = { ...u };
        if (displayName !== undefined) next.displayName = displayName;
        if (sharePublic !== undefined) next.sharePublic = !!sharePublic;
        if (avatar !== undefined) {
          if (avatar === null) delete next.avatar;
          else if (/^data:image\/(jpeg|png|webp);base64,/.test(avatar) && avatar.length <= 60000) next.avatar = avatar;
          else throw new Error('大頭貼格式不正確');
        }
        return next;
      }));
      me = byId(me.id);
      return me;
    },

    // ── 忘記密碼的問題（規則同雲端版：答案只存雜湊，24 小時內答錯 5 次就鎖住）──

    async recoveryStatus() {
      const r = allUsers().find((u) => u.id === me.id)?.recovery;
      return { supported: true, hasAnswers: !!r, updatedAt: r?.updatedAt || null };
    },

    async setRecoveryAnswers(animal, school) {
      const secret = recoverySecret(animal, school);
      if (!secret) throw new Error('答案不完整，請重新選擇');
      const salt = randomHex(8);
      const recovery = { salt, hash: await sha256(`${salt}:${secret}`), updatedAt: nowIso() };
      write(K_USERS, allUsers().map((u) => (u.id === me.id ? { ...u, recovery } : u)));
    },

    async clearRecoveryAnswers() {
      write(K_USERS, allUsers().map((u) => {
        if (u.id !== me.id) return u;
        const { recovery, ...rest } = u; // eslint-disable-line no-unused-vars
        return rest;
      }));
    },

    async recoveryAvailable(username) {
      const name = username.trim().replace(/^@/, '').toLowerCase();
      return allUsers().some((u) => u.username === name && !u.demo && u.recovery);
    },

    async resetPassword({ username, animal, school, newPassword }) {
      const name = username.trim().replace(/^@/, '').toLowerCase();
      const u = allUsers().find((x) => x.username === name && !x.demo);
      if (!u || !u.recovery) return 'wrong';
      const DAY = 864e5;
      const fails = read(K_RECOVERY_FAILS, {});
      const recent = (fails[u.id] || []).filter((t) => Date.now() - t < DAY);
      if (recent.length >= MAX_FAILED_ATTEMPTS) return 'locked';
      if (newPassword.length < 6) return 'weak_password';
      const secret = recoverySecret(animal, school);
      if (!secret || (await sha256(`${u.recovery.salt}:${secret}`)) !== u.recovery.hash) {
        fails[u.id] = [...recent, Date.now()];
        write(K_RECOVERY_FAILS, fails);
        return 'wrong';
      }
      const salt = randomHex(8);
      const hash = await sha256(`${salt}:${newPassword}`);
      write(K_USERS, allUsers().map((x) => (x.id === u.id ? { ...x, salt, hash } : x)));
      delete fails[u.id];
      write(K_RECOVERY_FAILS, fails);
      return 'ok';
    },

    async findUser(username) {
      const u = allUsers().find((x) => x.username === username.toLowerCase());
      return u && u.id !== me.id ? profile(u) : null;
    },

    async searchUsers(q) {
      q = q.toLowerCase();
      return allUsers()
        .filter((u) => u.id !== me.id && (u.username.includes(q) || u.displayName.toLowerCase().includes(q)))
        .slice(0, 20)
        .map(profile);
    },

    async listFriendships() {
      const out = { friends: [], incoming: [], outgoing: [] };
      for (const f of friendships()) {
        if (f.requester !== me.id && f.addressee !== me.id) continue;
        const other = byId(f.requester === me.id ? f.addressee : f.requester);
        if (!other) continue;
        if (f.status === 'accepted') out.friends.push(other);
        else if (f.addressee === me.id) out.incoming.push(other);
        else out.outgoing.push(other);
      }
      return out;
    },

    async sendFriendRequest(targetId) {
      const list = friendships();
      const f = list.find((x) => (x.requester === me.id && x.addressee === targetId) || (x.requester === targetId && x.addressee === me.id));
      if (f) {
        if (f.status === 'accepted') return 'already_friends';
        if (f.requester === targetId) { f.status = 'accepted'; write(K_FRIENDS, list); return 'accepted'; }
        return 'already_requested';
      }
      const target = allUsers().find((u) => u.id === targetId);
      if (!target) throw new Error('找不到這位使用者');
      // 示範好友會立刻接受邀請
      list.push({ requester: me.id, addressee: targetId, status: target.demo ? 'accepted' : 'pending', createdAt: nowIso() });
      write(K_FRIENDS, list);
      return target.demo ? 'accepted' : 'requested';
    },

    /** 推薦好友：共同好友多的在前，不夠再用最近加入的補滿（規則同雲端版 suggest_friends） */
    async suggestFriends(limit = 8) {
      const lim = Math.min(Math.max(Number(limit) || 8, 1), 20);
      const all = friendships();
      const other = (f, id) => (f.requester === id ? f.addressee : f.requester);
      const mine = new Set(all.filter((f) => f.requester === me.id || f.addressee === me.id).map((f) => other(f, me.id)));
      const myFriends = new Set(all.filter((f) => f.status === 'accepted' && (f.requester === me.id || f.addressee === me.id)).map((f) => other(f, me.id)));
      const mutual = new Map();
      for (const f of all) {
        if (f.status !== 'accepted') continue;
        for (const [x, y] of [[f.requester, f.addressee], [f.addressee, f.requester]]) {
          if (myFriends.has(x) && y !== me.id) mutual.set(y, (mutual.get(y) || 0) + 1);
        }
      }
      return allUsers()
        .filter((u) => u.id !== me.id && !mine.has(u.id))
        .map((u) => ({ u, n: mutual.get(u.id) || 0 }))
        .sort((a, b) => b.n - a.n
          || (b.u.createdAt || '').localeCompare(a.u.createdAt || '')
          || a.u.username.localeCompare(b.u.username))
        .slice(0, lim)
        .map(({ u, n }) => ({ ...profile(u), mutualCount: n }));
    },

    /**
     * 推薦貼文（規則同雲端版 recommended_posts）：同意公開、不是我、沒有任何好友關係、今天有畫。
     * 共同好友多的在前，再依最近發佈時間。回傳和 fetchFriendsToday 一樣的貼文格式，多一個 mutualCount。
     */
    async recommendedPosts(limit = 6) {
      const lim = Math.min(Math.max(Number(limit) || 6, 1), 20);
      await ensureDemoPosts(dayKey());
      const all = friendships();
      const other = (f, id) => (f.requester === id ? f.addressee : f.requester);
      const related = new Set(all.filter((f) => f.requester === me.id || f.addressee === me.id).map((f) => other(f, me.id)));
      const myFriends = new Set(all.filter((f) => f.status === 'accepted' && (f.requester === me.id || f.addressee === me.id)).map((f) => other(f, me.id)));
      const mutual = new Map();
      for (const f of all) {
        if (f.status !== 'accepted') continue;
        for (const [x, y] of [[f.requester, f.addressee], [f.addressee, f.requester]]) {
          if (myFriends.has(x) && y !== me.id) mutual.set(y, (mutual.get(y) || 0) + 1);
        }
      }
      const now = nowIso();
      const out = [];
      for (const u of allUsers()) {
        const p = profile(u);
        if (u.id === me.id || related.has(u.id) || !p.sharePublic) continue;
        const [ds, ns] = await run(cloud, ['drawings', 'notes'], 'readonly', ({ drawings, notes }) => Promise.all([
          promisify(drawings.index('byUser').getAll(u.id)),
          promisify(notes.getAll(IDBKeyRange.bound([u.id, ''], [u.id, '￿']))),
        ]));
        const live = ds.filter((d) => d.expiresAt > now).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (!live.length) continue;
        const note = ns.filter((x) => x.expiresAt > now).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const times = [...live.map((d) => d.createdAt), note?.updatedAt].filter(Boolean).sort();
        out.push({
          profile: p,
          mutualCount: mutual.get(u.id) || 0,
          drawings: live.map(({ id, width, height, createdAt, image }) => ({ id, width, height, createdAt, image })),
          note: note?.note || '',
          lastAt: times[times.length - 1] || null,
        });
      }
      return out
        .sort((a, b) => b.mutualCount - a.mutualCount || (b.lastAt || '').localeCompare(a.lastAt || '')
          || a.profile.username.localeCompare(b.profile.username))
        .slice(0, lim);
    },

    async acceptFriend(otherId) {
      const list = friendships();
      const f = list.find((x) => x.requester === otherId && x.addressee === me.id);
      if (f) { f.status = 'accepted'; write(K_FRIENDS, list); }
    },

    async removeFriend(otherId) {
      write(K_FRIENDS, friendships().filter((x) => !((x.requester === me.id && x.addressee === otherId) || (x.requester === otherId && x.addressee === me.id))));
    },

    async uploadDrawing({ id, day, image, width, height, expiresAt }) {
      await run(cloud, 'drawings', 'readwrite', ({ drawings }) => promisify(drawings.put({
        id, userId: me.id, day, image, width, height, createdAt: nowIso(), expiresAt,
      })));
      // 讓示範更有感：過幾秒，示範好友就會來留言
      const owner = me.id;
      setTimeout(() => {
        if (me?.id === owner) getDrawing(id).then((d) => d && ensureCannedComments([d])).catch(() => {});
      }, 4000);
    },

    async deleteDrawing(id) {
      await run(cloud, ['drawings', 'comments'], 'readwrite', async ({ drawings, comments }) => {
        const d = await promisify(drawings.get(id));
        if (d && d.userId !== me.id) throw new Error('只能刪除自己的畫');
        for (const c of await promisify(comments.index('byDrawing').getAll(id))) comments.delete(c.id);
        drawings.delete(id);
      });
    },

    // ── 留言：規則與真正的雲端版（RLS）一致 ──

    async fetchComments(drawingIds) {
      const ids = [...new Set(drawingIds)];
      const [lists, live] = await Promise.all([
        run(cloud, 'comments', 'readonly', ({ comments }) =>
          Promise.all(ids.map((id) => promisify(comments.index('byDrawing').getAll(id))))),
        Promise.all(ids.map(async (id) => { const d = await getDrawing(id); return [id, !!d && d.expiresAt > nowIso()]; })),
      ]);
      const isLive = new Map(live);
      return lists.flat()
        .filter((c) => c.drawingOwner === me.id || c.author === me.id
          || (isFriend(c.drawingOwner, me.id) && isLive.get(c.drawingId)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(pubComment);
    },

    async addComment(drawingId, body) {
      body = String(body ?? '').trim();
      if (!body || body.length > COMMENT_MAX) throw new Error(`留言需要 1–${COMMENT_MAX} 個字`);
      const d = await getDrawing(drawingId);
      if (!d || d.expiresAt <= nowIso()) throw new Error('這張畫已經過了今天，不能再留言了');
      if (d.userId !== me.id && !isFriend(d.userId, me.id)) throw new Error('只有好友可以在今天的畫上留言');
      const mine = await run(cloud, 'comments', 'readonly', ({ comments }) => promisify(comments.index('byDrawing').getAll(drawingId)));
      if (mine.filter((c) => c.author === me.id).length >= COMMENT_CAP) throw new Error('你在這張畫上的留言已經太多了，先到這裡吧');
      const c = { id: `c-${randomHex(8)}`, drawingId, drawingOwner: d.userId, author: me.id, day: d.day, body, createdAt: nowIso() };
      await putCloudComment(c);
      return pubComment(c);
    },

    async deleteComment(id) {
      await run(cloud, 'comments', 'readwrite', async ({ comments }) => {
        const c = await promisify(comments.get(id));
        if (c && (c.author === me.id || c.drawingOwner === me.id)) comments.delete(id);
      });
    },

    async saveNote({ day, note, expiresAt }) {
      await run(cloud, 'notes', 'readwrite', ({ notes }) => promisify(
        note.trim() ? notes.put({ userId: me.id, day, note, updatedAt: nowIso(), expiresAt }) : notes.delete([me.id, day]),
      ));
    },

    async fetchMyToday(day) {
      const now = nowIso();
      const [ds, n] = await run(cloud, ['drawings', 'notes'], 'readonly', ({ drawings, notes }) => Promise.all([
        promisify(drawings.index('byUser').getAll(me.id)),
        promisify(notes.get([me.id, day])),
      ]));
      const live = ds.filter((d) => d.day === day && d.expiresAt > now);
      await ensureCannedComments(live);
      return {
        drawings: live.map(({ id, width, height, createdAt }) => ({ id, width, height, createdAt })),
        note: n && n.expiresAt > now ? n.note : '',
      };
    },

    async fetchDrawingImage(id) {
      const d = await run(cloud, 'drawings', 'readonly', ({ drawings }) => promisify(drawings.get(id)));
      if (!d || d.expiresAt <= nowIso()) throw new Error('這張畫已經不在雲端了');
      return d.image;
    },

    async fetchFriendsToday() {
      const today = dayKey();
      await ensureDemoPosts(today);
      const { friends } = await api.listFriendships();
      const now = nowIso();
      const result = [];
      for (const p of friends) {
        const [ds, ns] = await run(cloud, ['drawings', 'notes'], 'readonly', ({ drawings, notes }) => Promise.all([
          promisify(drawings.index('byUser').getAll(p.id)),
          promisify(notes.getAll(IDBKeyRange.bound([p.id, ''], [p.id, '￿']))),
        ]));
        const live = ds.filter((d) => d.expiresAt > now).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const note = ns.filter((x) => x.expiresAt > now).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const times = [...live.map((d) => d.createdAt), note?.updatedAt].filter(Boolean).sort();
        result.push({
          profile: p,
          drawings: live.map(({ id, width, height, createdAt, image }) => ({ id, width, height, createdAt, image })),
          note: note?.note || '',
          lastAt: times[times.length - 1] || null,
        });
      }
      return result;
    },

    async purgeMyPast() {
      await purgeExpired();
    },
  };
  return api;
}
