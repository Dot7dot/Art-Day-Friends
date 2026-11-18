// 忘記密碼的兩個安全問題：動物清單與答案整理規則
// 整理規則要和 supabase/schema.sql 裡的 recovery_norm_school() 完全一致。

export const ANIMALS = [
  { key: 'poison_dart_frog', label: '箭毒蛙' },
  { key: 'red_fire_ant', label: '紅火蟻' },
  { key: 'tardigrade', label: '水熊蟲' },
  { key: 'platypus', label: '鴨嘴獸' },
  { key: 'axolotl', label: '六角恐龍' },
  { key: 'shoebill', label: '鯨頭鸛' },
  { key: 'tarsier', label: '眼鏡猴' },
  { key: 'naked_mole_rat', label: '裸鼴鼠' },
  { key: 'mantis_shrimp', label: '螳螂蝦' },
  { key: 'sunfish', label: '翻車魚' },
];

export const isAnimal = (key) => ANIMALS.some((a) => a.key === key);

export const SCHOOL_MAX = 60;
export const MAX_FAILED_ATTEMPTS = 5;

// 空白與標點（ASCII 標點、拉丁標點、一般標點、中日韓標點）
const STRIP = /[\s!-/:-@[-`{-~ -¿ -⁯⸀-⹿　-〿︰-﹏]/g;

/** 整理學校名稱：NFKC → 去頭尾空白 → 小寫 → 去空白與標點 → 臺→台 → 去掉結尾的 國民小學／國小／小學。可能回傳空字串。 */
export function normalizeSchool(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(STRIP, '')
    .replaceAll('臺', '台')
    .replace(/(國民小學|國小|小學)$/, '');
}

/** 要拿去雜湊的字串；答案不合規格時回傳 null */
export function recoverySecret(animal, school) {
  const norm = normalizeSchool(school);
  if (!isAnimal(animal) || !norm || String(school).length > SCHOOL_MAX) return null;
  return `${animal}|${norm}`;
}

/** 檢查表單輸入；回傳錯誤訊息，沒問題回傳空字串 */
export function checkRecoveryInput(animal, school) {
  if (!isAnimal(animal)) return '請選擇最喜歡的動物';
  if (!normalizeSchool(school)) return '請填寫你畢業的國小（只寫「國小」兩個字是不夠的）';
  if (String(school).length > SCHOOL_MAX) return '學校名稱太長了';
  return '';
}

export const MSG = {
  unsupported: '這個網站還沒開啟「忘記密碼」功能，請聯絡網站管理員',
  resetFailed: '目前無法重設，請聯絡網站管理員',
};
