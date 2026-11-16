# Art Day · 藝術小日曆

每天隨手畫一張，只給今天的朋友看。

**網站：** https://dot7dot.github.io/Art-Day-Friends/

## 它是什麼

Art Day 是一個給藝術家的小日曆：

- **自己註冊帳號**，每天上傳隨手畫的圖（或直接在 App 裡「隨手畫」），也可以寫一段當天的文字記錄。
- **好友機制**：互相加好友後，就能看到對方**今天**畫的圖和文字。
- **只有今天**：好友只看得到當天的畫，看不到以前的。過了午夜就消失。
- **畫留在身邊**：所有的畫都存在你自己的裝置裡，在「日曆」頁一格一格地累積成你的藝術日曆。

## 儲存方式（節省雲端空間）

| | 存在哪裡 | 存多久 |
|---|---|---|
| 你所有的畫（原圖品質，最長邊 2048px） | **本機**：這台裝置瀏覽器的 IndexedDB | 永久（直到你刪除或清除瀏覽器資料） |
| 今天的畫（壓縮副本，最長邊 1280px） | **雲端**共用空間 | 只到今天結束，隔天自動刪除 |
| 今天的文字記錄 | 本機 + 雲端 | 雲端同樣只留到今天結束 |

雲端每人每天最多放 6 張，所以就算用免費方案，空間也不會越用越多。

隔天的清除有三道保險：

1. 資料庫的安全規則（RLS）會讓「已過期」的畫立刻對好友隱藏。
2. 每次有人打開 App，都會刪掉自己昨天以前的雲端副本，並順手清掉所有人已過期的資料。
3. 若有開啟 pg_cron，資料庫每 30 分鐘也會自動清一次。

> 因為圖片主要存在瀏覽器裡，**清除瀏覽器資料或換手機前，請到「我的」頁面匯出備份**。在「我的」頁面也可以開啟「防止瀏覽器自動清除」。

## 兩種模式

### 本機示範模式（預設）

`js/config.js` 還沒填 Supabase 設定時，App 會以示範模式運作：

- 帳號、好友與「雲端」都模擬在這台裝置的瀏覽器裡，打開網站就能直接體驗。
- 附有三位示範好友（`@momo_draws`、`@ashu_sketch`、`@lin_doodle`），每天都會「畫」一張新的圖。
- 規則和雲端版一樣：好友只看得到今天的，過了午夜就從「雲端」移除。

### 雲端模式（讓朋友真正互相分享）

需要一個免費的 [Supabase](https://supabase.com) 專案（帳號、好友名單、今天的畫都存在這裡）。

1. **建立專案**：到 supabase.com 註冊，New project（免費方案即可，地區可以選 Tokyo 或 Singapore）。
2. **建立資料表**：左側 **SQL Editor** → New query → 把 [`supabase/schema.sql`](supabase/schema.sql) 的內容整份貼上 → **Run**。
   - 看到 `pg_cron 尚未啟用` 的提示也沒關係。想要自動排程清除的話，到 **Integrations → Cron** 開啟後再執行一次即可。
3. **設定登入網址**：**Authentication → URL Configuration**
   - Site URL 填 `https://dot7dot.github.io/Art-Day-Friends/`
   - （建議）**Authentication → Sign In / Providers → Email** 關掉 **Confirm email**，註冊後就能直接使用；若保持開啟，使用者需先點確認信。
4. **填入金鑰**：**Project Settings → API**（或 **Data API**），複製 **Project URL** 和 **anon public** key，填進 [`js/config.js`](js/config.js)：

   ```js
   export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```

   anon key 本來就設計成可以放在前端公開，資料安全由 `schema.sql` 裡的 Row Level Security 規則保護：
   - 只有登入的人能查看使用者 ID 與暱稱。
   - 只有**互相是好友**的人，才看得到彼此**今天**的畫與文字。
   - 每個人只能新增、刪除自己的畫。

5. **推上 GitHub**：commit 並 push 到 `main`，幾分鐘後網站就會更新。

## 發佈到 GitHub Pages

這個專案是純靜態網站，不需要建置。第一次發佈時：

1. 到 GitHub repo 的 **Settings → Pages**。
2. **Source** 選 **Deploy from a branch**，Branch 選 **`main`**、資料夾 **`/ (root)`** → Save。
3. 等一兩分鐘，網站就會出現在 `https://dot7dot.github.io/Art-Day-Friends/`。

之後每次推到 `main` 都會自動更新。

## 在自己電腦上預覽

```bash
python3 -m http.server 8000
# 打開 http://localhost:8000
```

（需要用 http 伺服器開啟，直接雙擊 `index.html` 會因為瀏覽器安全限制無法載入模組。）

## 專案結構

```
index.html                 入口
css/style.css              樣式（白色系、淡橘線條、圓角平面）
js/config.js               ← Supabase 設定填這裡
js/app.js                  畫面與流程：今天／好友／日曆／我的
js/archive.js              本機日曆存檔（IndexedDB）
js/imaging.js              圖片壓縮：本機版、雲端副本、縮圖
js/sketch.js               隨手畫畫板
js/backend-supabase.js     雲端模式
js/backend-local.js        本機示範模式
js/demo-art.js             示範好友的每日小畫
vendor/                    supabase-js（已打包成單一檔案，不依賴 CDN）
supabase/schema.sql        資料表、安全規則、自動清除
```
