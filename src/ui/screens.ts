// 各主狀態的畫面。只讀 AppView、只呼叫 AppController 方法。
import type { AppController, AppView, RecoveryReason } from '../app/appController';
import { registerDayIndex } from '../domain/profile/daily';
import { roundOfDay, type Profile } from '../domain/profile/profile';
import { starToRank } from '../domain/profile/rank';
import { msUntilNextStamina } from '../domain/profile/stamina';
import { dayKeyOf } from '../domain/time/calendar';
import type { GameData } from '../data';
import { downloadJson, formatClock, formatTime, h } from './dom';
import { rankRewardAvailable } from '../domain/profile/shop';
import type { Panel, PanelState } from './metaScreens';
import { icon, inkMountains, type IconName } from './icons';
import { VERSIONS, type BuildInfo } from '../app/version';

export interface UiState {
  settingsOpen: boolean;
  confirmReset: boolean;
  panels: PanelState;
  /** 伺服器上有較新的版本（只在主畫面提示） */
  update: BuildInfo | null;
}

export function renderLoading(): HTMLElement {
  return h('main', { class: 'screen center' }, h('h1', { class: 'title' }, '趙雲與阿斗'), h('p', { class: 'muted' }, '載入中…'));
}

const FEATURES: { label: string; panel: Panel; icon: IconName }[] = [
  { label: '武器', panel: 'weapons', icon: 'sword' },
  { label: '商店', panel: 'shop', icon: 'shop' },
  { label: '段位', panel: 'rank', icon: 'rank' },
  { label: '圖鑑', panel: 'codex', icon: 'book' },
];

export function renderLobby(view: AppView, ui: UiState, app: AppController, rerender: () => void): HTMLElement {
  const data = view.data!;
  const p = view.profile!;
  const now = Date.now();
  const today = dayKeyOf(now, data.economy.calendarZone);
  const staminaMax = data.economy.stamina.max;
  const cost = data.economy.stamina.battleCost;
  const lacking = p.stamina.value < cost;

  // 功能卡片的副標與提醒：讓玩家不點進去也知道裡面有什麼
  const shopOpen = p.openProps || starToRank(p.rank.curStar).rankId >= data.items.shopUnlockRankId;
  const sub: Record<Panel, string> = {
    weapons:
      !p.weaponFree && registerDayIndex(p, today) < data.weapons.unlockOnRegisterDay
        ? `第 ${data.weapons.unlockOnRegisterDay} 天解鎖`
        : `${data.generals.generals.filter((g) => p.equip[g.id]! >= 0).length} 位武將已裝備`,
    shop: shopOpen ? `今日道具 ${p.items.length} 件` : `${data.ranks.ranks[data.items.shopUnlockRankId]!.name} 開放`,
    rank: `每日 ${data.ranks.ranks[starToRank(p.rank.lastStar).rankId]!.reward} 金幣`,
    codex: `已解鎖 ${p.mergedGenerals.length}/${data.generals.generals.length}`,
  };
  const badge: Partial<Record<Panel, string>> = {
    ...(p.newWeaponIds.length > 0 ? { weapons: '新' } : {}),
    ...(rankRewardAvailable(p, today) ? { rank: '可領' } : {}),
  };

  const screen = h(
    'main',
    { class: 'screen lobby' },
    h(
      'header',
      { class: 'resbar' },
      h('div', { class: 'res gold card', 'aria-label': `金幣 ${p.gold}` }, icon('coin'), h('strong', null, p.gold), h('span', { class: 'res-sub' }, '金幣')),
      h(
        'div',
        { class: 'res stamina card', 'aria-label': `體力 ${p.stamina.value}/${staminaMax}` },
        icon('stamina'),
        h('strong', null, `${p.stamina.value}`, h('span', { class: 'res-sub' }, ` / ${staminaMax}`)),
        h('span', { class: 'res-sub', id: 'stamina-next' }, staminaHint(p, data, now)),
      ),
      h(
        'button',
        {
          class: 'icon-btn',
          'aria-label': '設定',
          title: '設定',
          onclick: () => {
            ui.settingsOpen = true;
            rerender();
          },
        },
        icon('gear'),
      ),
    ),
    heroCard(p, data, today),
    h(
      'button',
      {
        class: 'primary battle-btn',
        disabled: view.busy || lacking,
        onclick: () => void app.startBattle(),
      },
      icon('swords'),
      h('span', { class: 'big' }, '出戰'),
      h('small', null, lacking ? `體力不足（需要 ${cost}，${staminaHint(p, data, now)}）` : `消耗 ${cost} 體力 · 對手為本機 AI`),
    ),
    h(
      'nav',
      { class: 'features', 'aria-label': '功能' },
      ...FEATURES.map((f) =>
        h(
          'button',
          {
            class: 'tile',
            onclick: () => {
              ui.panels.panel = f.panel;
              ui.panels.message = null;
              if (f.panel === 'shop') ui.panels.shop = null;
              rerender();
            },
          },
          h('span', { class: 'tile-icon' }, icon(f.icon)),
          h('span', { class: 'tile-label' }, f.label),
          h('span', { class: 'tile-sub' }, sub[f.panel]),
          badge[f.panel] ? h('span', { class: 'badge' }, badge[f.panel]!) : null,
        ),
      ),
    ),
    h(
      'footer',
      { class: 'savebar muted' },
      view.lastSavedAt ? `已保存 ${formatTime(view.lastSavedAt)}` : '進度保存在此瀏覽器',
      ` · v${VERSIONS.app}（${VERSIONS.commit}）`,
    ),
  );
  if (ui.update) {
    screen.prepend(
      h(
        'div',
        { class: 'notice', role: 'status' },
        h('span', null, `有新版本（${ui.update.commit}）可以更新。`),
        h('button', { class: 'link', onclick: () => location.reload() }, '重新整理更新'),
      ),
    );
  }
  if (view.notice) screen.prepend(noticeBar(view.notice, () => app.dismissNotice()));
  if (ui.settingsOpen) screen.append(settingsDialog(p, ui, app, rerender));
  return screen;
}

export function staminaHint(p: Profile, data: GameData, now: number): string {
  const s = data.economy.stamina;
  const ms = msUntilNextStamina(p.stamina, now, { max: s.max, recoverIntervalMs: s.recoverIntervalMs });
  return ms === null ? '已滿' : `${formatClock(ms)} 後 +1`;
}

/** 主畫面頂部：水墨遠山上的標題、段位印章與戰績 */
function heroCard(p: Profile, data: GameData, today: string): HTMLElement {
  const pos = starToRank(p.rank.curStar);
  const rank = data.ranks.ranks[pos.rankId]!;
  const emperor = pos.rankId >= 50;
  const stars = emperor
    ? `${pos.level} 星`
    : '★'.repeat(pos.level) + '☆'.repeat(Math.max(0, data.ranks.starsPerRank - pos.level));
  return h(
    'section',
    { class: 'hero card' },
    inkMountains(),
    h('h1', { class: 'hero-title' }, '趙雲與阿斗', h('span', { class: 'seal-mini', 'aria-hidden': 'true' }, '斗')),
    h(
      'div',
      { class: 'rank-line' },
      h('div', { class: 'seal' }, rank.name.split('.')[0]!.slice(0, 2)),
      h('div', null, h('div', { class: 'rank-name' }, rank.name), h('div', { class: 'rank-stars', 'aria-label': `第 ${pos.level} 星` }, stars)),
    ),
    h(
      'div',
      { class: 'record' },
      h('span', { class: 'chip' }, icon('flag'), `${p.stats.win} 勝 ${p.stats.lose} 敗`),
      h('span', { class: 'chip' }, icon('swords'), `本日第 ${roundOfDay(p)} 局`),
      h('span', { class: 'chip' }, icon('calendar'), `第 ${registerDayIndex(p, today)} 天`),
    ),
  );
}

function noticeBar(text: string, onClose: () => void): HTMLElement {
  return h('div', { class: 'notice', role: 'status' }, h('span', null, text), h('button', { class: 'link', onclick: onClose }, '知道了'));
}

/** 開關列：整列可點，狀態同時以滑塊位置與顏色表示 */
function settingRow(label: string, hint: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: 'setting' },
    h('span', { class: 'setting-text' }, label, h('small', null, hint)),
    h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
  );
}

export function closeSettings(ui: UiState, rerender: () => void): void {
  ui.settingsOpen = false;
  rerender();
}

function settingsDialog(p: Profile, ui: UiState, app: AppController, rerender: () => void): HTMLElement {
  const close = () => closeSettings(ui, rerender);
  return h(
    'div',
    { class: 'backdrop sheet', onclick: (e: Event) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '設定' },
      h('div', { class: 'dialog-head' }, h('h2', null, '設定'), h('button', { class: 'icon-btn ghost', 'aria-label': '關閉設定', onclick: close }, icon('close'))),
      settingRow('顯示傷害數字', '對局中敵人頭上的傷害數字', p.settings.showDamageNumbers, (on) => void app.updateSettings({ showDamageNumbers: on })),
      settingRow('減少特效', '關閉震動、晃動、粒子與介面動畫', p.settings.reduceEffects, (on) => void app.updateSettings({ reduceEffects: on })),
      h(
        'section',
        { class: 'dialog-section' },
        h('h3', null, icon('download'), '存檔'),
        h('p', { class: 'muted small' }, '進度只保存在這個瀏覽器。清除網站資料會一併刪除，建議定期匯出備份。'),
        h('button', { onclick: () => void exportTo(app, 'zhaoyun-adou-save') }, icon('download'), '匯出存檔'),
      ),
      h(
        'section',
        { class: 'dialog-section' },
        h('h3', null, '版本'),
        h(
          'p',
          { class: 'muted small' },
          `程式 v${VERSIONS.app}（${VERSIONS.commit}）· 規則 ${VERSIONS.ruleset} · 存檔格式 ${VERSIONS.saveSchema} · 資料庫 ${VERSIONS.db}`,
        ),
      ),
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
  'other-tab': { title: '遊戲已在其他分頁開啟', body: '' },
  'settle-failed': {
    title: '結算尚未保存',
    body: '對局結果已凍結，但寫入存檔失敗，獎勵尚未入帳。按「重試」會完成同一筆結算，不會重複發獎。',
  },
};

export function renderRecovery(view: AppView, ui: UiState, app: AppController, rerender: () => void): HTMLElement {
  const reason = view.recovery!;
  const text = RECOVERY_TEXT[reason.kind];
  if (reason.kind === 'other-tab') {
    return h(
      'main',
      { class: 'screen center recovery' },
      h('h1', null, reason.lost ? '已在其他分頁繼續' : '遊戲已在其他分頁開啟'),
      h(
        'p',
        null,
        reason.lost
          ? '另一個分頁接手了這份進度。為避免兩邊互相覆蓋，這個分頁已停止寫入；進行中的對局在那個分頁繼續。'
          : '同一份進度一次只能在一個分頁遊玩，以免兩邊互相覆蓋。',
      ),
      h('p', { class: 'muted' }, '在這裡繼續會讓另一個分頁停止寫入，並從最後保存的進度接著玩。'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void app.takeOver() }, '在這個分頁繼續')),
    );
  }
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
