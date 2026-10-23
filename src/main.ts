import { AppController, type AppView } from './app/appController';
import { checkForUpdate } from './app/version';
import { systemClock } from './domain/time/calendar';
import { openGameDb } from './storage/db';
import { BattleScreen } from './ui/battleScreen';
import { renderInterrupted, renderOpponent, renderResult, renderSettling } from './ui/flowScreens';
import { newPanelState, renderPanel } from './ui/metaScreens';
import { renderLoading, renderLobby, renderRecovery, staminaHint, type UiState } from './ui/screens';
import './ui/styles.css';

const root = document.getElementById('app')!;

/** 執行前檢查瀏覽器能力；缺少時直接說明，不進入遊戲 */
function missingFeatures(): string[] {
  const missing: string[] = [];
  if (typeof indexedDB === 'undefined') missing.push('IndexedDB（本機存檔）');
  if (typeof structuredClone !== 'function') missing.push('structuredClone（對局快照）');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(0);
  } catch {
    missing.push('時區（每日重置）');
  }
  return missing;
}
const missing = missingFeatures();
if (missing.length > 0) {
  (window as unknown as { __zyadBooted: boolean }).__zyadBooted = true;
  root.innerHTML = `<div class="boot-fail"><h1>瀏覽器不支援</h1><p>缺少：${missing.join('、')}。請改用較新版本的瀏覽器；私密瀏覽模式也可能停用本機存檔。</p></div>`;
  throw new Error(`unsupported: ${missing.join(', ')}`);
}
const app = new AppController({ clock: systemClock, openDb: () => openGameDb(), ownerId: tabOwnerId() });

/**
 * 分頁識別：存在 sessionStorage，同一分頁重新整理後沿用，可立即取回寫入權；新分頁拿到新的。
 * 複製分頁會帶著同一個識別，但取得寫入權時編號必定 +1，舊分頁的寫入仍會被擋下。
 */
function tabOwnerId(): string {
  const fresh = `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  try {
    const saved = sessionStorage.getItem('zyad-owner');
    if (saved) return saved;
    sessionStorage.setItem('zyad-owner', fresh);
  } catch {
    // 無法使用 sessionStorage 時，每次載入視為新分頁
  }
  return fresh;
}
const ui: UiState = { settingsOpen: false, confirmReset: false, panels: newPanelState(), update: null };
let latest: AppView = app.view;
let battleUi: BattleScreen | null = null;
// 開發模式除錯入口（正式建置會移除）
if (import.meta.env.DEV) (window as unknown as { __app: AppController }).__app = app;

function render(): void {
  const v = latest;
  const inBattle = (v.state === 'BATTLE_RUNNING' || v.state === 'BATTLE_PAUSED') && v.session;
  if (inBattle) {
    // 同一場對局只建一次畫面，避免重建 canvas 中斷拖曳
    if (!battleUi || battleUi.session !== v.session) {
      battleUi?.destroy();
      battleUi = new BattleScreen(v.session!, app, v);
    } else battleUi.sync(v);
    if (root.firstChild !== battleUi.root) root.replaceChildren(battleUi.root);
    return;
  }
  if (battleUi) {
    battleUi.destroy();
    battleUi = null;
  }
  const screen =
    v.state === 'LOBBY' && v.profile && v.data && ui.panels.panel
      ? renderPanel({ view: v, app, ps: ui.panels, rerender: render })
      : v.state === 'LOBBY' && v.profile && v.data
      ? renderLobby(v, ui, app, render)
      : v.state === 'RECOVERY' && v.recovery
        ? renderRecovery(v, ui, app, render)
        : v.state === 'OPPONENT_PRESENTATION' && v.battle
          ? renderOpponent(v, app)
          : v.state === 'PROFILE_READY' && v.interrupted && v.battle
            ? renderInterrupted(v, app)
            : v.state === 'SETTLING'
              ? renderSettling()
              : v.state === 'RESULT' && v.receipt
                ? renderResult(v, app)
                : renderLoading();
  root.replaceChildren(screen);
}

app.subscribe((v) => {
  latest = v;
  render();
  // 已畫出第一個畫面：取消 index.html 的保底逾時
  (window as unknown as { __zyadBooted: boolean }).__zyadBooted = true;
});

// 只更新倒數文字，不重建畫面也不寫檔
setInterval(() => {
  const el = document.getElementById('stamina-next');
  if (el && latest.profile && latest.data) el.textContent = staminaHint(latest.profile, latest.data, Date.now());
}, 1000);

// 切走分頁：戰鬥自動暫停、不在背景追算；回到主畫面時補計體力與跨日
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (app.machine.state === 'BATTLE_RUNNING' || app.machine.state === 'BATTLE_PAUSED') app.pause('PAGE_HIDDEN');
  } else if (app.machine.state === 'LOBBY') void app.refreshDaily();
});
setInterval(() => {
  if (app.machine.state === 'LOBBY') void app.refreshDaily();
}, 30_000);
// 停在主畫面時每 10 分鐘檢查一次新版；只提示，不強制重新整理（對局中不打擾）
const pollUpdate = async () => {
  if (app.machine.state !== 'LOBBY' || ui.update) return;
  ui.update = await checkForUpdate();
  if (ui.update) render();
};
setInterval(() => void pollUpdate(), 10 * 60_000);

// 關閉或重新整理分頁時讓出寫入權，新分頁不必等租約到期（不保證一定執行，所以租約另有到期時間）
window.addEventListener('pagehide', () => void app.releaseLease());

void app.boot();
