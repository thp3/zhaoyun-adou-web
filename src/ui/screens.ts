// 各主狀態的畫面。只讀 AppView、只呼叫 AppController 方法。
import type { AppController, AppView, RecoveryReason } from '../app/appController';
import { registerDayIndex } from '../domain/profile/daily';
import { roundOfDay, type Profile } from '../domain/profile/profile';
import { starToRank } from '../domain/profile/rank';
import { msUntilNextStamina } from '../domain/profile/stamina';
import { dayKeyOf } from '../domain/time/calendar';
import type { GameData } from '../data';
import { downloadJson, formatClock, formatTime, h } from './dom';

export interface UiState {
  settingsOpen: boolean;
  confirmReset: boolean;
}

export function renderLoading(): HTMLElement {
  return h('main', { class: 'screen center' }, h('h1', { class: 'title' }, '趙雲與阿斗'), h('p', { class: 'muted' }, '載入中…'));
}

const FEATURES: { label: string; milestone: string }[] = [
  { label: '武器', milestone: 'M5' },
  { label: '商店', milestone: 'M5' },
  { label: '段位', milestone: 'M5' },
  { label: '圖鑑', milestone: 'M5' },
];

export function renderLobby(view: AppView, ui: UiState, app: AppController, rerender: () => void): HTMLElement {
  const data = view.data!;
  const p = view.profile!;
  const now = Date.now();
  const today = dayKeyOf(now, data.economy.calendarZone);
  const staminaMax = data.economy.stamina.max;
  const cost = data.economy.stamina.battleCost;

  const screen = h(
    'main',
    { class: 'screen lobby' },
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, '金幣'), h('strong', null, p.gold)),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat-label' }, '體力'),
        h('strong', null, `${p.stamina.value}/${staminaMax}`),
        h('span', { class: 'stat-sub', id: 'stamina-next' }, staminaHint(p, data, now)),
      ),
    ),
    rankCard(p, data),
    h(
      'section',
      { class: 'record' },
      h('span', null, `戰績 ${p.stats.win} 勝 ${p.stats.lose} 敗`),
      h('span', null, `本日第 ${roundOfDay(p)} 局`),
      h('span', null, `註冊第 ${registerDayIndex(p, today)} 天`),
    ),
    h(
      'button',
      { class: 'primary big', disabled: true, title: '對局於 M2 開放' },
      '出　戰',
      h('small', null, `消耗 ${cost} 體力 · 對局於 M2 開放`),
    ),
    h(
      'nav',
      { class: 'features' },
      ...FEATURES.map((f) =>
        h('button', { class: 'tile', disabled: true, title: `${f.milestone} 開放` }, f.label, h('small', null, '即將推出')),
      ),
      h(
        'button',
        {
          class: 'tile',
          onclick: () => {
            ui.settingsOpen = true;
            rerender();
          },
        },
        '設定',
      ),
    ),
    h(
      'footer',
      { class: 'savebar muted' },
      view.lastSavedAt ? `已保存 ${formatTime(view.lastSavedAt)}` : '進度保存在此瀏覽器',
      ` · 規則 ${data.manifest.rulesetVersion}`,
    ),
  );
  if (view.notice) screen.prepend(noticeBar(view.notice, () => app.dismissNotice()));
  if (ui.settingsOpen) screen.append(settingsDialog(p, ui, app, rerender));
  return screen;
}

export function staminaHint(p: Profile, data: GameData, now: number): string {
  const s = data.economy.stamina;
  const ms = msUntilNextStamina(p.stamina, now, { max: s.max, recoverIntervalMs: s.recoverIntervalMs });
  return ms === null ? '已滿' : `${formatClock(ms)} 後 +1`;
}

function rankCard(p: Profile, data: GameData): HTMLElement {
  const pos = starToRank(p.rank.curStar);
  const rank = data.ranks.ranks[pos.rankId]!;
  const emperor = pos.rankId >= 50;
  const stars = emperor
    ? `${pos.level} 星`
    : '★'.repeat(pos.level) + '☆'.repeat(Math.max(0, data.ranks.starsPerRank - pos.level));
  return h(
    'section',
    { class: 'rank-card' },
    h('div', { class: 'seal' }, rank.name.split('.')[0]!.slice(0, 2)),
    h('div', null, h('div', { class: 'rank-name' }, rank.name), h('div', { class: 'rank-stars', 'aria-label': `第 ${pos.level} 星` }, stars)),
  );
}

function noticeBar(text: string, onClose: () => void): HTMLElement {
  return h('div', { class: 'notice', role: 'status' }, h('span', null, text), h('button', { class: 'link', onclick: onClose }, '知道了'));
}

function settingsDialog(p: Profile, ui: UiState, app: AppController, rerender: () => void): HTMLElement {
  const close = () => {
    ui.settingsOpen = false;
    rerender();
  };
  return h(
    'div',
    { class: 'backdrop', onclick: (e: Event) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '設定' },
      h('h2', null, '設定'),
      h(
        'label',
        { class: 'row' },
        h('input', {
          type: 'checkbox',
          checked: p.settings.showDamageNumbers,
          onchange: (e: Event) => void app.updateSettings({ showDamageNumbers: (e.target as HTMLInputElement).checked }),
        }),
        '顯示傷害數字',
      ),
      h('h3', null, '存檔'),
      h('p', { class: 'muted' }, '進度只保存在這個瀏覽器。清除網站資料會一併刪除，建議定期匯出備份。'),
      h('button', { onclick: () => void exportTo(app, 'zhaoyun-adou-save') }, '匯出存檔'),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'primary', onclick: close }, '關閉')),
    ),
  );
}

async function exportTo(app: AppController, prefix: string): Promise<void> {
  const file = await app.exportSave();
  if (!file) return;
  const stamp = new Date(file.exportedAt).toISOString().slice(0, 19).replaceAll(':', '');
  downloadJson(`${prefix}-${stamp}.json`, file);
}

const RECOVERY_TEXT: Record<RecoveryReason['kind'], { title: string; body: string }> = {
  data: { title: '遊戲資料載入失敗', body: '規則資料表格式有誤，請重新整理或更新到最新版本。你的存檔沒有被更動。' },
  'storage-unavailable': {
    title: '無法開啟本機存檔',
    body: '瀏覽器拒絕或無法使用本機儲存（例如私密瀏覽、空間不足或已停用網站資料）。沒有扣除或改動任何進度。',
  },
  corrupt: {
    title: '存檔無法讀取',
    body: '存檔內容損壞或格式不符。為避免遺失資料，遊戲不會自動覆寫。你可以先匯出原始存檔，再決定是否建立新存檔。',
  },
  'too-new': {
    title: '存檔來自較新的版本',
    body: '這份存檔是由較新版本的遊戲建立，目前版本無法安全讀取。請更新頁面後再試，存檔沒有被更動。',
  },
  'write-failed': { title: '寫入存檔失敗', body: '沒有保存成功，請確認瀏覽器儲存空間後重試。' },
};

export function renderRecovery(view: AppView, ui: UiState, app: AppController, rerender: () => void): HTMLElement {
  const reason = view.recovery!;
  const text = RECOVERY_TEXT[reason.kind];
  const issues = 'issues' in reason ? reason.issues : 'message' in reason ? [reason.message] : [`存檔版本 v${reason.version}`];
  const canExport = reason.kind === 'corrupt' || reason.kind === 'too-new';
  return h(
    'main',
    { class: 'screen center recovery' },
    h('h1', null, text.title),
    h('p', null, text.body),
    h('details', null, h('summary', null, '技術細節'), h('pre', null, issues.slice(0, 50).join('\n'))),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', onclick: () => void app.retry() }, '重試'),
      canExport && h('button', { onclick: () => void exportTo(app, 'zhaoyun-adou-raw') }, '匯出原始存檔'),
      reason.kind === 'corrupt' &&
        (ui.confirmReset
          ? h(
              'span',
              { class: 'confirm' },
              '確定建立新存檔？舊存檔會保留在備份區。',
              h(
                'button',
                {
                  class: 'danger',
                  onclick: () => {
                    ui.confirmReset = false;
                    void app.replaceCorruptSave();
                  },
                },
                '確定',
              ),
              h(
                'button',
                {
                  onclick: () => {
                    ui.confirmReset = false;
                    rerender();
                  },
                },
                '取消',
              ),
            )
          : h(
              'button',
              {
                class: 'danger',
                onclick: () => {
                  ui.confirmReset = true;
                  rerender();
                },
              },
              '建立新存檔…',
            )),
    ),
  );
}
