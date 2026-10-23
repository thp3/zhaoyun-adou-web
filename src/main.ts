import { AppController, type AppView } from './app/appController';
import { systemClock } from './domain/time/calendar';
import { openGameDb } from './storage/db';
import { renderLoading, renderLobby, renderRecovery, staminaHint, type UiState } from './ui/screens';
import './ui/styles.css';

const root = document.getElementById('app')!;
const app = new AppController({ clock: systemClock, openDb: () => openGameDb() });
const ui: UiState = { settingsOpen: false, confirmReset: false };
let latest: AppView = app.view;

function render(): void {
  const v = latest;
  const screen =
    v.state === 'LOBBY' && v.profile && v.data
      ? renderLobby(v, ui, app, render)
      : v.state === 'RECOVERY' && v.recovery
        ? renderRecovery(v, ui, app, render)
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

// 回到前景與主畫面停留期間：補計體力、處理跨日
const refresh = () => {
  if (app.machine.state === 'LOBBY') void app.refreshDaily();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
setInterval(refresh, 30_000);

void app.boot();
