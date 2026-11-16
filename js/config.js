// ─────────────────────────────────────────────────────────────
//  Art Day 設定檔
// ─────────────────────────────────────────────────────────────
//  想讓大家跨裝置註冊、加好友、看到彼此今天的畫，
//  請建立一個免費的 Supabase 專案，並把下面兩個值填上（步驟見 README.md）。
//
//  兩個值都留空 → App 會以「本機示範模式」運作：
//  帳號、好友與「雲端」都只存在這台裝置的瀏覽器裡，方便先體驗。
//
//  anon public key 本來就設計成可以公開放在前端，
//  資料安全由資料庫的 Row Level Security 規則保護（見 supabase/schema.sql）。
// ─────────────────────────────────────────────────────────────

export const SUPABASE_URL = 'https://hjslgoxniiysyjnupyri.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_HMTOnp6WRu4m8ScjcPTJyw_ukHuK9xi'; // publishable key：可公開

// 每個人每天最多同步到雲端的圖片張數（超過的只存在本機）
export const MAX_CLOUD_DRAWINGS_PER_DAY = 6;
