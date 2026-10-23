// 對局前後的畫面：對手準備、中斷處理、結算中、結果。
import type { AppController, AppView } from '../app/appController';
import { starToRank } from '../domain/profile/rank';
import { h } from './dom';
import { icon, type IconName } from './icons';

export function renderOpponent(view: AppView, app: AppController): HTMLElement {
  const b = view.battle!;
  const data = view.data!;
  const map = data.maps.maps[b.setup.mapId]!;
  const ai = starToRank(b.setup.aiStar);
  const aiRank = data.ranks.ranks[ai.rankId]!;
  const aiRankText = ai.rankId >= 50 ? `${aiRank.name} ${ai.level} 星` : `${aiRank.name} 第 ${ai.level} 星`;
  const me = view.profile ? starToRank(view.profile.rank.curStar) : null;
  const meRank = me ? data.ranks.ranks[me.rankId]! : null;
  return h(
    'main',
    { class: 'screen center' },
    h('div', { class: 'map-banner' }, icon('flag'), `戰場 · ${map.name}`),
    h(
      'section',
      { class: 'card versus' },
      h(
        'div',
        { class: 'versus-side' },
        h('div', { class: 'seal' }, '我方'),
        h('div', { class: 'versus-name' }, '你'),
        meRank && h('div', { class: 'muted small' }, meRank.name),
      ),
      h('div', { class: 'versus-vs', 'aria-label': '對戰' }, 'VS'),
      h(
        'div',
        { class: 'versus-side ai' },
        h('div', { class: 'seal' }, '敵方'),
        h('div', { class: 'versus-name' }, '敵軍'),
        h('div', { class: 'muted small' }, b.setup.aiEnabled ? aiRankText : '按兵不動'),
      ),
    ),
    h(
      'ul',
      { class: 'card rules' },
      h(
        'li',
        null,
        icon('shield'),
        b.setup.aiEnabled ? '守住己方阿斗：撐過 20 波，或讓對方阿斗先失守即勝利。' : '敵軍按兵不動：撐過 20 波即勝利。',
      ),
      b.setup.tutorial ? h('li', null, icon('scroll'), '初陣：跟著提示學會佈陣，敵軍不會太強。') : null,
      h('li', null, icon('stamina'), `已扣除 ${b.staminaCost} 體力。開始前取消會退還，開始後不退。`),
      b.setup.aiEnabled ? h('li', { class: 'muted' }, icon('swords'), '敵軍由電腦指揮，並非真人玩家。') : null,
    ),
    h(
      'div',
      { class: 'stack' },
      h('button', { class: 'primary battle-btn', disabled: view.busy, onclick: () => void app.beginBattle() }, icon('swords'), h('span', { class: 'big' }, '開戰')),
      h('button', { disabled: view.busy, onclick: () => void app.cancelPrepared() }, icon('back'), `取消並退還 ${b.staminaCost} 體力`),
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
    h('p', null, `上一場戰鬥在第 ${wave} 波中斷，無法接續。`),
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
  const drops = d.drops ?? [];
  const starDiff = d.starAfter - d.starBefore;
  const row = (name: IconName, label: string, value: Node | string) => h('div', { class: 'reward-row' }, icon(name), h('dt', null, label), h('dd', null, value));
  return h(
    'main',
    { class: 'screen center result' },
    h('h1', { class: `result-stamp ${win ? 'win' : 'lose'}` }, win ? '勝利' : draft.reason === 'surrender' ? '放棄' : '敗北'),
    h(
      'div',
      { class: 'record' },
      h('span', { class: 'chip' }, icon('flag'), REASON_TEXT[draft.reason] ?? ''),
      h('span', { class: 'chip' }, icon('shield'), `第 ${draft.wave} 波`),
      h('span', { class: 'chip' }, icon('swords'), `擊殺 ${draft.kills}`),
    ),
    h(
      'dl',
      { class: 'card reward-list' },
      row('coin', '金幣', h('strong', null, `+${d.goldDelta}`)),
      row(
        'sword',
        '碎片',
        drops.length === 0
          ? h('span', { class: 'muted' }, '無')
          : Object.entries(drops.reduce<Record<string, number>>((m, id) => ((m[id] = (m[id] ?? 0) + 1), m), {}))
              .map(([id, n]) => `${data.weapons.weapons.find((x) => x.id === Number(id))?.name ?? id} ×${n}`)
              .join('、'),
      ),
      row(
        'rank',
        '段位',
        starDiff === 0
          ? `${rankName(d.starAfter)}（未變）`
          : h('span', null, `${rankName(d.starAfter)} `, h('span', { class: starDiff > 0 ? 'up' : 'down' }, starDiff > 0 ? `▲ ${starDiff} 星` : `▼ ${-starDiff} 星`)),
      ),
    ),
    h('p', { class: 'center-text muted small' }, '獎勵已入帳'),
    h('button', { class: 'primary battle-btn', onclick: () => void app.backToLobby() }, h('span', { class: 'big' }, '回主畫面')),
  );
}
