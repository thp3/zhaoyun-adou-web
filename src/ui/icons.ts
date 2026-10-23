// 介面圖示：全部是寫在程式裡的 SVG 路徑（24×24、線條用 currentColor），不載入任何圖檔。
// 圖示只輔助辨識，旁邊一律配文字，不單獨用來表意。

const PATHS = {
  coin: '<circle cx="12" cy="12" r="8.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".6"/>',
  stamina: '<path d="M13 2.5 5.5 13.5h5.5l-1 8 7.5-11h-5.5z"/>',
  sword: '<path d="M14.5 4.5 20 4l-.5 5.5-9 9"/><path d="m6.5 13.5 4 4"/><path d="m4 20 3.5-3.5"/><path d="m5 15 4 4"/>',
  shop: '<path d="M4 8h16l-1.2 11.2a1 1 0 0 1-1 .8H6.2a1 1 0 0 1-1-.8z"/><path d="M8.5 8V6.5a3.5 3.5 0 0 1 7 0V8"/>',
  rank: '<path d="M7 3h10v7.5L12 14l-5-3.5z"/><circle cx="12" cy="17.5" r="3.5"/>',
  book: '<path d="M4 5.5c2.5-1.5 5.5-1.5 8 0 2.5-1.5 5.5-1.5 8 0V19c-2.5-1.5-5.5-1.5-8 0-2.5-1.5-5.5-1.5-8 0z"/><path d="M12 5.5V19"/>',
  gear:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.2"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4.5h11l-2.5 4 2.5 4H6"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.5 3 7.8 7 9.5 4-1.7 7-5 7-9.5V6z"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M3 9h18M12 9v11"/><path d="M12 9c-1.5-3-5.5-4-5.5-1.5S10 9 12 9c1.5-3 5.5-4 5.5-1.5S14 9 12 9"/>',
  download: '<path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M5 20h14"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="1.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  swords: '<path d="m4 4 9.5 9.5M4 4h3.5L17 13.5M4 4v3.5L13.5 17"/><path d="m14 17 3 3 3-3-3-3"/><path d="m20 4-6 6M20 4h-3.5M20 4v3.5"/><path d="m4 20 3-3"/>',
  scroll: '<path d="M7 4h11a2 2 0 0 1 2 2v1h-4"/><path d="M16 7v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1h10"/><path d="M7 4a2 2 0 0 0-2 2v11"/><path d="M9 9h4M9 12.5h4"/>',
  recycle: '<path d="M7.5 10 5 14.5h5"/><path d="M5 14.5 7.5 19H12"/><path d="m14 5.5-2-1-2 3.5"/><path d="M12 4.5 16.5 12"/><path d="M19 14.5 16.5 19H12"/><path d="m16.5 12 2.5 2.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, cls = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.innerHTML = PATHS[name];
  return svg;
}

/** 主畫面頂端的水墨遠山（程式產生的 SVG，不是圖檔） */
export function inkMountains(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 120');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ink-mountains');
  svg.innerHTML = `
    <path class="m3" d="M0 78 C40 60 70 66 100 52 C130 38 150 58 185 46 C220 34 250 50 280 40 C320 28 360 48 400 36 V120 H0Z"/>
    <path class="m2" d="M0 92 C30 80 60 70 90 76 C120 82 140 62 175 66 C210 70 230 84 265 74 C300 64 330 70 360 80 C380 86 392 82 400 78 V120 H0Z"/>
    <path class="m1" d="M0 104 C50 96 80 100 120 94 C160 88 200 104 240 100 C290 95 330 102 400 96 V120 H0Z"/>`;
  return svg;
}
