// 對局前後的畫面：對手準備、中斷處理、結算中、結果。
import type { AppController, AppView } from '../app/appController';
import { starToRank } from '../domain/profile/rank';
import { h } from './dom';

export function renderOpponent(view: AppView, app: AppController): HTMLElement {
  const b = view.battle!;
  const data = view.data!;
  const map = data.maps.maps[b.setup.mapId]!;
  return h(
    'main',
    { class: 'screen center' },
    h('h1', { class: 'title' }, '對手準備'),
    h(
      'section',
      { class: 'rank-card' },
      h('div', { class: 'seal' }, map.name.slice(0, 2)),
      h('div', null, h('div', { class: 'rank-name' }, `戰場：${map.name}`), h('div', { class: 'muted' }, '對手：本機 AI')),
    ),
    h('p', { class: 'muted' }, '本版本 AI 尚未出手（M3 加入）：撐過 20 波即勝利。對手由本機產生，不是真人配對。'),
    h('p', { class: 'muted' }, `已扣除 ${b.staminaCost} 體力。開始前取消會退還，開始後不退。`),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary big', disabled: view.busy, onclick: () => void app.beginBattle() }, '開　戰'),
      h('button', { disabled: view.busy, onclick: () => void app.cancelPrepared() }, `取消並退還 ${b.staminaCost} 體力`),
    ),
  );
}

export function renderInterrupted(view: AppView, app: AppController): HTMLElement {
  const b = view.battle!;
  const wave = b.progress.wave;
  const early = wave < view.data!.economy.battleReward.earlySurrenderWave;
  return h(
    'main',
    { class: 'screen center' },
    h('h1', null, '上一場對局被中斷'),
    h('p', null, `對局在第 ${wave} 波時關閉或重新整理。目前版本還不能從中途續玩（M6 加入）。`),
    h('p', { class: 'muted' }, `將以「放棄」結算：計一場敗北${early ? '，第 5 波前放棄不給金幣' : '，可得敗北金幣'}。結算只會執行一次。`),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void app.settleInterrupted() }, '結算並返回主畫面')),
  );
}

export function renderSettling(): HTMLElement {
  return h('main', { class: 'screen center' }, h('h1', { class: 'title' }, '結算中'), h('p', { class: 'muted' }, '正在保存結果…'));
}

const REASON_TEXT: Record<string, string> = {
  'waves-cleared': '守住了全部 20 波',
  'ai-dead': '對方阿斗失守',
  'player-dead': '我方阿斗失守',
  surrender: '主動放棄',
};

export function renderResult(view: AppView, app: AppController): HTMLElement {
  const r = view.receipt!;
  const data = view.data!;
  const d = r.delta!;
  const draft = r.draft!;
  const win = d.outcome === 'win';
  const rankName = (star: number) => {
    const pos = starToRank(star);
    const rank = data.ranks.ranks[pos.rankId]!;
    return pos.rankId >= 50 ? `${rank.name} ${pos.level} 星` : `${rank.name} 第 ${pos.level} 星`;
  };
  return h(
    'main',
    { class: 'screen center result' },
    h('h1', { class: `title ${win ? 'win' : 'lose'}` }, win ? '勝　利' : draft.reason === 'surrender' ? '放　棄' : '敗　北'),
    h('p', { class: 'center-text muted' }, `${REASON_TEXT[draft.reason] ?? ''} · 到達第 ${draft.wave} 波 · 擊殺 ${draft.kills}`),
    h(
      'dl',
      { class: 'result-list' },
      h('dt', null, '金幣'),
      h('dd', null, `+${d.goldDelta}（已入帳）`),
      h('dt', null, '段位'),
      h(
        'dd',
        null,
        rankName(d.starBefore) === rankName(d.starAfter)
          ? `${rankName(d.starAfter)}（未變）`
          : `${rankName(d.starBefore)} → ${rankName(d.starAfter)}`,
      ),
    ),
    h('button', { class: 'primary big', onclick: () => void app.backToLobby() }, '回主畫面'),
  );
}
