// 主畫面上的面板：武器背包、道具商店、段位、圖鑑。面板疊在 LOBBY 之上，不另開應用狀態。
import type { AppController, AppView } from '../app/appController';
import { registerDayIndex } from '../domain/profile/daily';
import { backpack, recyclePreview } from '../domain/profile/inventory';
import { starToRank } from '../domain/profile/rank';
import { rankRewardAvailable, type ShopSession } from '../domain/profile/shop';
import { dayKeyOf } from '../domain/time/calendar';
import { h } from './dom';

export type Panel = 'weapons' | 'shop' | 'rank' | 'codex';

export interface PanelState {
  panel: Panel | null;
  shop: ShopSession | null;
  message: string | null;
  recycle: number[];
  confirmRecycle: boolean;
}

export function newPanelState(): PanelState {
  return { panel: null, shop: null, message: null, recycle: [0], confirmRecycle: false };
}

type Ctx = { view: AppView; app: AppController; ps: PanelState; rerender: () => void };

export function renderPanel(c: Ctx): HTMLElement {
  const { ps, rerender } = c;
  const title = { weapons: '武器', shop: '道具商店', rank: '段位', codex: '圖鑑' }[ps.panel!];
  const body =
    ps.panel === 'weapons' ? weaponsPanel(c) : ps.panel === 'shop' ? shopPanel(c) : ps.panel === 'rank' ? rankPanel(c) : codexPanel(c);
  return h(
    'main',
    { class: 'screen panel' },
    h(
      'header',
      { class: 'panel-head' },
      h('button', { class: 'link', onclick: () => ((ps.panel = null), (ps.message = null), rerender()) }, '← 返回'),
      h('h1', null, title),
    ),
    ps.message && h('div', { class: 'notice', role: 'status' }, ps.message),
    body,
  );
}

async function act(c: Ctx, p: Promise<string | null>, okText: string): Promise<void> {
  const err = await p;
  c.ps.message = err ?? okText;
  c.rerender();
}

// ---------------- 武器 ----------------

function weaponsPanel(c: Ctx): HTMLElement {
  const { view, app, ps } = c;
  const data = view.data!;
  const p = view.profile!;
  const today = dayKeyOf(Date.now(), data.economy.calendarZone);
  if (!p.weaponFree && registerDayIndex(p, today) < data.weapons.unlockOnRegisterDay) {
    return h('p', { class: 'muted' }, `武器系統於註冊第 ${data.weapons.unlockOnRegisterDay} 天解鎖，屆時會發放四把普通武器。`);
  }
  const wname = (id: number) => (id < 0 ? '預設' : (data.weapons.weapons.find((w) => w.id === id)?.name ?? '?'));
  const rarityColor = (r: number) => data.weapons.rarityColors[r] ?? 'inherit';
  const fresh = p.newWeaponIds.length
    ? h(
        'div',
        { class: 'notice' },
        h('span', null, `獲得新武器：${[...new Set(p.newWeaponIds)].map(wname).join('、')}`),
        h('button', { class: 'link', onclick: () => void act(c, app.clearNewWeapons(), '') }, '知道了'),
      )
    : null;

  const slots = h(
    'section',
    { class: 'card-list' },
    h('h2', null, '武將裝備'),
    ...data.generals.generals.map((g) =>
      h(
        'div',
        { class: 'row-item' },
        h('strong', null, g.name),
        h('span', { class: 'muted' }, data.weapons.typeNames[g.weaponType]),
        h('span', { class: 'grow' }, wname(p.equip[g.id]!)),
        p.equip[g.id]! >= 0 && h('button', { onclick: () => void act(c, app.unequipWeapon(g.id), '已卸下') }, '卸下'),
      ),
    ),
  );

  const bag = backpack(p, data);
  const bagEl = h(
    'section',
    { class: 'card-list' },
    h('h2', null, '背包'),
    bag.length === 0
      ? h('p', { class: 'muted' }, '還沒有武器碎片。對局中擊殺帶碎片的敵人會掉落。')
      : null,
    ...bag.map((s) => {
      const eligible = data.generals.generals.filter((g) => g.weaponType === s.def.type);
      const select = h('select', { 'aria-label': `把${s.def.name}裝給` }, ...eligible.map((g) => h('option', { value: String(g.id) }, g.name)));
      return h(
        'div',
        { class: 'row-item wrap' },
        h('strong', { style: `color:${rarityColor(s.def.rarity)}` }, s.def.name),
        h('span', { class: 'muted' }, `${data.weapons.rarityNames[s.def.rarity]} · ${data.weapons.typeNames[s.def.type]} · 攻擊 +${s.def.addAttPower}`),
        h('span', null, s.complete > 0 ? `完整 ${s.complete}（可用 ${s.available}）` : `碎片 ${s.leftover}/${s.required}`),
        s.complete > 0 && s.leftover > 0 ? h('span', { class: 'muted' }, `餘片 ${s.leftover}/${s.required}`) : null,
        h('p', { class: 'muted small' }, s.def.intro),
        s.available > 0
          ? h(
              'span',
              { class: 'actions' },
              select,
              h('button', { onclick: () => void act(c, app.equipWeapon(Number(select.value), s.weaponId), `已裝備${s.def.name}`) }, '裝備'),
            )
          : null,
      );
    }),
  );

  const preview = recyclePreview(p, ps.recycle, data);
  const recycleEl = h(
    'section',
    { class: 'card-list' },
    h('h2', null, '回收'),
    h('p', { class: 'muted small' }, '已裝備的武器不會被回收。每片碎片：普通 1、稀有 2、卓越 3 金幣。'),
    h(
      'div',
      { class: 'actions' },
      ...[0, 1, 2].map((r) =>
        h(
          'label',
          { class: 'row' },
          h('input', {
            type: 'checkbox',
            checked: ps.recycle.includes(r),
            onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              ps.recycle = on ? [...ps.recycle, r] : ps.recycle.filter((x) => x !== r);
              ps.confirmRecycle = false;
              c.rerender();
            },
          }),
          data.weapons.rarityNames[r],
        ),
      ),
    ),
    ps.confirmRecycle
      ? h(
          'div',
          { class: 'actions' },
          h('span', null, `確定回收 ${preview.rows.length} 種武器，得 ${preview.gold} 金幣？`),
          h('button', { class: 'danger', onclick: () => ((ps.confirmRecycle = false), void act(c, app.recycleWeapons(ps.recycle), `回收完成，+${preview.gold} 金幣`)) }, '確定'),
          h('button', { onclick: () => ((ps.confirmRecycle = false), c.rerender()) }, '取消'),
        )
      : h('button', { disabled: preview.gold <= 0, onclick: () => ((ps.confirmRecycle = true), c.rerender()) }, `回收（+${preview.gold} 金幣）`),
  );
  return h('div', { class: 'panel-body' }, fresh, slots, bagEl, recycleEl);
}

// ---------------- 商店 ----------------

function shopPanel(c: Ctx): HTMLElement {
  const { view, app, ps } = c;
  const data = view.data!;
  const p = view.profile!;
  const unlocked = p.openProps || starToRank(p.rank.curStar).rankId >= data.items.shopUnlockRankId;
  if (!unlocked) return h('p', { class: 'muted' }, `段位達到「${data.ranks.ranks[data.items.shopUnlockRankId]!.name}」後開放道具商店。`);
  if (!ps.shop) {
    void app.openShop().then((s) => {
      ps.shop = s;
      c.rerender();
    });
    return h('p', { class: 'muted' }, '讀取商品中…');
  }
  const s = ps.shop;
  const isActive = (id: number) => data.items.items[id]!.active;
  const owned = h(
    'section',
    { class: 'card-list' },
    h('h2', null, `今日道具（主動 ${p.items.filter((i) => isActive(i.id)).length}/${data.items.capacity.active}、被動 ${p.items.filter((i) => !isActive(i.id)).length}/${data.items.capacity.passive}）`),
    p.items.length === 0 ? h('p', { class: 'muted' }, '還沒有道具。道具每天重置。') : null,
    ...p.items.map((i) => {
      const def = data.items.items[i.id]!;
      return h('div', { class: 'row-item' }, h('strong', null, def.levels ? `${def.name} ${i.level} 級` : def.name), h('span', { class: 'muted grow' }, def.intro.replace('{type}', '').replace('{level}', String(def.levels?.[i.level - 1]?.promoteChancePct ?? ''))));
    }),
  );
  const offers = h(
    'section',
    { class: 'card-list' },
    h('h2', null, s.soldOut ? '商品（本次已售罄，下次打開商店會換一批）' : '商品（買一件即整組售罄）'),
    ...s.offers.map((o, i) => {
      const def = data.items.items[o.itemId]!;
      return h(
        'div',
        { class: 'row-item wrap' },
        h('strong', { style: `color:${data.items.rarityColors[def.levels?.[o.level - 1]?.rarity ?? def.rarity] ?? 'inherit'}` }, def.levels ? `${def.name} ${o.level} 級` : def.name),
        h('span', { class: 'muted grow' }, `${def.active ? '主動' : '被動'} · ${def.intro.replace('{type}', '').replace('{level}', String(def.levels?.[o.level - 1]?.promoteChancePct ?? ''))}`),
        h(
          'button',
          {
            class: 'primary',
            disabled: s.soldOut || p.gold < o.price,
            onclick: async () => {
              const r = await app.buyOffer(s.sessionId, i);
              if (r.ok) ps.shop = r.session;
              ps.message = r.ok ? `已購買${def.name}` : r.reason;
              c.rerender();
            },
          },
          `${o.price} 金幣`,
        ),
      );
    }),
  );
  const lottery = h(
    'section',
    { class: 'card-list' },
    h('h2', null, '輪盤'),
    h('p', { class: 'muted small' }, '原版輪盤需要看完獎勵影片才能轉。本版沒有接廣告服務，所以暫不開放，以免假裝成功發獎。'),
  );
  return h('div', { class: 'panel-body' }, h('p', null, `金幣 ${p.gold}`), offers, owned, lottery);
}

// ---------------- 段位 ----------------

function rankPanel(c: Ctx): HTMLElement {
  const { view, app } = c;
  const data = view.data!;
  const p = view.profile!;
  const pos = starToRank(p.rank.curStar);
  const today = dayKeyOf(Date.now(), data.economy.calendarZone);
  const yesterday = data.ranks.ranks[starToRank(p.rank.lastStar).rankId]!;
  const canClaim = rankRewardAvailable(p, today);
  return h(
    'div',
    { class: 'panel-body' },
    h(
      'section',
      { class: 'rank-card' },
      h('div', { class: 'seal' }, data.ranks.ranks[pos.rankId]!.name.split('.')[0]!.slice(0, 2)),
      h('div', null, h('div', { class: 'rank-name' }, data.ranks.ranks[pos.rankId]!.name), h('div', { class: 'muted' }, pos.rankId >= 50 ? `${pos.level} 星` : `第 ${pos.level} 星`)),
    ),
    h(
      'section',
      { class: 'card-list' },
      h('h2', null, '每日段位獎勵'),
      h('p', { class: 'muted small' }, `依每日重置時的段位（${yesterday.name}）發放，每天一次。`),
      h('button', { class: 'primary', disabled: !canClaim, onclick: () => void act(c, app.claimRankReward(), `已領取 ${yesterday.reward} 金幣`) }, canClaim ? `領取 ${yesterday.reward} 金幣` : '今天已領取'),
    ),
    h(
      'section',
      { class: 'card-list' },
      h('h2', null, '段位表'),
      h(
        'table',
        { class: 'rank-table' },
        h('thead', null, h('tr', null, h('th', null, '段位'), h('th', null, '每日金幣'), h('th', null, '第 10 波後敵人血量'))),
        h(
          'tbody',
          null,
          ...data.ranks.ranks
            .filter((r, i) => i === 0 || r.name !== data.ranks.ranks[i - 1]!.name || i >= 50)
            .map((r) => h('tr', { class: r.id === pos.rankId ? 'current' : '' }, h('td', null, r.id >= 50 ? `${r.name}（${r.id - 49}）` : r.name), h('td', null, r.reward), h('td', null, `+${Math.round(r.addHp * 100)}%`))),
        ),
      ),
    ),
  );
}

// ---------------- 圖鑑 ----------------

function codexPanel(c: Ctx): HTMLElement {
  const data = c.view.data!;
  const p = c.view.profile!;
  return h(
    'div',
    { class: 'panel-body card-list' },
    h('p', { class: 'muted small' }, `已解鎖 ${p.mergedGenerals.length}/${data.generals.generals.length}。在對局中把姓名字依序相鄰排好，就能合成武將並解鎖。`),
    ...data.generals.generals.map((g) => {
      const open = p.mergedGenerals.includes(g.key);
      const skill = g.skill ? data.generals.skills.find((s) => s.id === g.skill!.skill) : null;
      return h(
        'div',
        { class: 'row-item wrap' },
        h('strong', null, open ? g.name : '？？'),
        h('span', { class: 'muted' }, `${data.weapons.typeNames[g.weaponType]} · 最高 ${g.maxLevel} 級`),
        open
          ? h('p', { class: 'small grow' }, skill ? `${skill.name}：${skill.description}${g.skill!.triggerAttacks ? `（每 ${g.skill!.triggerAttacks} 次攻擊）` : ''}` : '沒有具名技能')
          : h('p', { class: 'muted small grow' }, '尚未合成'),
      );
    }),
  );
}
