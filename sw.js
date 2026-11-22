// Art Day 的 service worker：讓網站可以安裝成 App，並在離線時還打得開。
//
// 規則很簡單：
//  • 只處理「同網域的 GET」。Supabase 與任何其他網域的請求一律不碰、不快取（登入、好友、圖片都不能被存起來）。
//  • 網路優先：有網路就永遠拿最新的（還會向伺服器確認有沒有更新，不吃瀏覽器的舊快取），
//    拿到就順便更新快取；沒網路或太慢才用快取。所以更新網站後，下次打開就是新版。
//  • skipWaiting + clients.claim：新版 service worker 一裝好就接手，不會卡在舊版。
//
// 改了這支檔案或要清掉舊快取時，把下面的版本號加一。
const VERSION = 'artday-v2';
const CACHE = `artday-shell-${VERSION}`;
const NETWORK_TIMEOUT = 6000; // 網路太慢（例如訊號很差）就先給快取

// 第一次安裝時先存好，離線時才打得開（網址相對於這支檔案）
const PRECACHE = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'assets/icon.svg', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png',
  'js/app.js', 'js/album.js', 'js/archive.js', 'js/backend-local.js', 'js/backend-supabase.js',
  'js/camera.js', 'js/config.js', 'js/dates.js', 'js/demo-art.js', 'js/drawing-modal.js',
  'js/icons.js', 'js/idb.js', 'js/imaging.js', 'js/recovery.js', 'js/sketch.js', 'js/ui.js',
  'vendor/supabase-js-2.117.3.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 一個檔案失敗不影響其他（例如某個檔案暫時抓不到）
    await Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('artday-shell-') && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const fromCache = () => cache.match(request, { ignoreSearch: request.mode === 'navigate' })
    .then((hit) => hit || (request.mode === 'navigate' ? cache.match('index.html') : undefined));

  const network = fetch(request, { cache: 'no-cache' }).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
    return res;
  });

  const timeout = new Promise((resolve) => {
    setTimeout(async () => resolve(await fromCache()), NETWORK_TIMEOUT);
  });

  try {
    // 先到先贏；但「快取」只有在有東西時才會贏，沒有就繼續等網路
    return (await Promise.race([network, timeout])) || (await network);
  } catch (e) {
    const hit = await fromCache();
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase、Google Fonts 等：完全不碰
  if (url.pathname.includes('/__')) return;
  event.respondWith(networkFirst(req));
});
