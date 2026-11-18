// 線條圖示（24×24，圓角筆觸，跟著文字顏色）

const P = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  users: '<path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20"/><circle cx="10" cy="8" r="3.5"/><path d="M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.65a3.5 3.5 0 0 1 0 6.7"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M8 3v4M16 3v4M3.5 10.5h17"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pen: '<path d="M4 20l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19 4 20z"/><path d="M13.5 7.3l3.2 3.2"/>',
  image: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="9" cy="9" r="1.6"/><path d="M20.5 15.5l-4.8-4.8L6 20.5"/>',
  camera: '<path d="M4 9a2.5 2.5 0 0 1 2.5-2.5h1.2a1.5 1.5 0 0 0 1.2-.6l.7-1a1.5 1.5 0 0 1 1.2-.6h2.4a1.5 1.5 0 0 1 1.2.6l.7 1a1.5 1.5 0 0 0 1.2.6h1.2A2.5 2.5 0 0 1 20 9v7.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.8" r="3.4"/>',
  upload: '<path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15"/>',
  download: '<path d="M12 4v11.5M7.5 11L12 15.5l4.5-4.5"/><path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.9 9.5 4.5 4.5 0 0 1 17 18.5H7z"/>',
  cloudOff: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96M9 5.6A6 6 0 0 1 17.9 9.5a4.5 4.5 0 0 1 2.3 7.6M17 18.5H7M3 3l18 18"/>',
  device: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M11 18.5h2"/>',
  trash: '<path d="M4 7h16M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6 7l.9 12a1.8 1.8 0 0 0 1.8 1.5h6.6a1.8 1.8 0 0 0 1.8-1.5L18 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  left: '<path d="M14.5 6L8.5 12l6 6"/>',
  right: '<path d="M9.5 6l6 6-6 6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="3"/><path d="M15.5 8.5V6.5a3 3 0 0 0-3-3h-6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h2"/>',
  logout: '<path d="M10 20H6.5A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4H10"/><path d="M15 16.5l4.5-4.5L15 7.5M19.5 12H9.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  userPlus: '<circle cx="10" cy="8" r="4"/><path d="M3 20.5a7 7 0 0 1 12.5-4.3M19 14v6M16 17h6"/>',
  undo: '<path d="M9 14L4.5 9.5 9 5"/><path d="M4.5 9.5h9a6 6 0 0 1 0 12h-3"/>',
  eraser: '<path d="M8.5 20.5h12"/><path d="M5.2 15.3l9.9-9.9a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L12.4 17.1a4 4 0 0 1-2.8 1.2H8.4a2 2 0 0 1-1.4-.6l-1.8-1.8a1 1 0 0 1 0-1.4z"/><path d="M9.5 11l4.5 4.5"/>',
  shield: '<path d="M12 21s7.5-3.4 7.5-9.5V6L12 3 4.5 6v5.5C4.5 17.6 12 21 12 21z"/><path d="M9 12l2 2 4-4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  note: '<rect x="4.5" y="3.5" width="15" height="17" rx="3"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  chat: '<path d="M5.5 4.5h13A2.5 2.5 0 0 1 21 7v8a2.5 2.5 0 0 1-2.5 2.5H11L6.5 21v-3.5h-1A2.5 2.5 0 0 1 3 15V7a2.5 2.5 0 0 1 2.5-2.5z"/>',
  send: '<path d="M20.5 3.5L10 14M20.5 3.5L14 20.5l-4-6.5-6.5-4 17-6.5z"/>',
  mobileSave: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M12 8v6M9.3 11.5L12 14.2l2.7-2.7"/>',
  hourglass: '<path d="M7 3.5h10M7 20.5h10M8 3.5v3a4 4 0 0 0 1.6 3.2L12 12l2.4-2.3A4 4 0 0 0 16 6.5v-3M8 20.5v-3a4 4 0 0 1 1.6-3.2L12 12l2.4 2.3a4 4 0 0 1 1.6 3.2v3"/>',
};

export function icon(name, size = 22) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
