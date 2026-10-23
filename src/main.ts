import { AppController, type AppView } from './app/appController';
import { systemClock } from './domain/time/calendar';
import { openGameDb } from './storage/db';
import { BattleScreen } from './ui/battleScreen';
import { renderInterrupted, renderOpponent, renderResult, renderSettling } from './ui/flowScreens';
import { newPanelState, renderPanel } from './ui/metaScreens';
import { renderLoading, renderLobby, renderRecovery, staminaHint, type UiState } from './ui/screens';
import './ui/styles.css';

const root = document.getElementById('app')!;
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
const ui: UiState = { settingsOpen: false, confirmReset: false, panels: newPanelState() };
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
// 關閉或重新整理分頁時讓出寫入權，新分頁不必等租約到期（不保證一定執行，所以租約另有到期時間）
window.addEventListener('pagehide', () => void app.releaseLease());

void app.boot();
