// 25 種對局道具（原版 Zh / dn / 各道具 factory）。主動道具拖到目標使用，被動道具在開局 init 生效。
// 行軍丹（23）只在商店／輪盤領取體力，不進對局。動畫時長以固定延遲表示，屬待校正數值。
import type { GameData } from '../../data';
import { BUFF, addGlobal, applyBuff, hasBuff, onUnitLevelUp } from './buffs';
import { allocId, schedule } from './create';
import { damageEnemy, enemyHp, maxHpOf } from './enemies';
import { dissolveGeneralOf, feedAmount, gainExp, generalCenter, tryFormGeneral } from './generals';
import { nextFloat, nextInt } from './rng';
import { CELL, TICK_MS, ticks, type Actor, type BattleItem, type BoardLoc, type Enemy, type Side, type SlotLoc, type StepContext, type World } from './types';

export const ITEM = {
  shovel: 0, bulldozer: 1, writingBrush: 2, trainingSpell: 3, upLvlSpell: 4, lifePill: 5, longRange: 6, inkstone: 7,
  trap: 8, landmine: 9, attSpeedSpell: 10, exorcismSpell: 11, farmer: 12, recruit: 13, allAttSpeedSpell: 14,
  goingHandInHand: 15, xuMingPill: 16, daBuPill: 17, silt: 18, superShovel: 19, meteor: 20, trashCan: 21,
  promotionOrder: 22, marchPill: 23, goldSeeker: 24,
} as const;

type Result = { ok: true } | { ok: false; reason: string };
const ok: Result = { ok: true };
const no = (reason: string): Result => ({ ok: false, reason });
const rand = (w: World) => nextFloat(w.rng, 'combat');
const other = (s: Side): Side => (s === 0 ? 1 : 0);

export function hasItem(w: World, side: Side, itemId: number): BattleItem | undefined {
  return w.items[side].find((i) => i.itemId === itemId);
}

/** 由存檔道具清單建立對局道具欄（行軍丹不進對局） */
export function toBattleItems(list: { id: number; level: number }[]): BattleItem[] {
  return list.filter((i) => i.id !== ITEM.marchPill).map((i) => ({ itemId: i.id, level: i.level, cd: 0, uses: 0 }));
}

// ---------------- 被動道具開局 ----------------

export function initPassiveItems(w: World, ctx: StepContext): void {
  for (const side of [0, 1] as const) {
    for (const it of w.items[side]) {
      switch (it.itemId) {
        case ITEM.recruit: {
          // 招賢榜：牌庫裡每張名字字 50% 多放一張；之後抽到名字字會再消耗一張同字
          const deck = w.camps[side].deck;
          const n = deck.length;
          for (let i = 0; i < n; i++) {
            const t = deck[i]!;
            if (!ctx.data.deck.nonConsumable.includes(t) && rand(w) < 0.5) deck.push(t);
          }
          w.itemState.recruitBoost[side] = true;
          break;
        }
        case ITEM.allAttSpeedSpell:
          // 全體攻速符：雙方都 +10%，與持有者無關
          for (const s of [0, 1] as const) addGlobal(w, { sign: `allAtt${side}`, side: s, target: 'units', type: BUFF.attSpeed, num: 0.1, percent: true, timeMs: -1 }, ctx);
          break;
        case ITEM.goingHandInHand:
          // 齊頭並進：固定玩家 +50%、AI +30%，不依持有者翻轉
          addGlobal(w, { sign: `hand${side}`, side: 0, target: 'units', type: BUFF.attSpeed, num: 0.5, percent: true, timeMs: -1 }, ctx);
          addGlobal(w, { sign: `hand${side}`, side: 1, target: 'units', type: BUFF.attSpeed, num: 0.3, percent: true, timeMs: -1 }, ctx);
          break;
        case ITEM.xuMingPill:
          w.camps[side].lives += 5;
          w.camps[other(side)].lives += 3;
          break;
        case ITEM.daBuPill:
          w.camps[side].lives += 3;
          break;
        case ITEM.silt:
          w.itemState.silt[side] = true;
          addGlobal(w, { sign: `silt${side}`, side, target: 'enemies', type: BUFF.moveSpeed, num: -0.1, percent: true, timeMs: -1 }, ctx);
          break;
        case ITEM.goldSeeker:
          w.itemState.goldSeeker[side] = true;
          break;
      }
    }
  }
}

// ---------------- 每 tick ----------------

export function updateItems(w: World, ctx: StepContext): void {
  for (const side of [0, 1] as const) {
    for (const it of w.items[side]) if (it.cd > 0) it.cd -= 1;
    const st = w.itemState;
    if (hasItem(w, side, ITEM.farmer)) {
      st.farmerTimer[side] += 1;
      if (st.farmerTimer[side] >= ticks(30000)) {
        st.farmerTimer[side] = 0;
        spawnFarmer(w, side, ctx);
      }
    }
    if (hasItem(w, side, ITEM.superShovel)) {
      st.shovelTimer[side] += 1;
      if (st.shovelTimer[side] >= ticks(60000)) {
        st.shovelTimer[side] = 0;
        superShovel(w, side, ctx);
      }
    }
    if (st.meteorCd[side] > 0) st.meteorCd[side] -= 1;
  }
  updateFarmers(w, ctx);
  updateTraps(w, ctx);
  checkMeteor(w, ctx);
}

// ---------------- 農民 ----------------

function freeSlot(w: World, side: Side): number {
  return w.camps[side].slots.findIndex((id) => id === null);
}

function spawnFarmer(w: World, side: Side, ctx: StepContext): void {
  const id = allocId(w);
  const base = { id, side, token: 'farmer', kind: 'farmer' as const, level: 1, cooldown: 0, generalId: null, exp: 0, farm: { timer: 0, crazy: 0 } };
  // 先找己方空的待開墾地，沒有才放刷新欄
  for (let x = 0; x < w.kind.length; x++) {
    for (let y = 0; y < w.kind[x]!.length; y++) {
      if (w.kind[x]![y] === 2 && w.camp[x]![y] === side && w.board[x]![y] == null) {
        w.actors[id] = { ...base, loc: { c: 'board', x, y } };
        w.board[x]![y] = id;
        return;
      }
    }
  }
  const i = freeSlot(w, side);
  if (i < 0) return;
  w.actors[id] = { ...base, loc: { c: 'slot', i } };
  w.camps[side].slots[i] = id;
  void ctx;
}

/** 農民在待開墾地依等級週期產金；放到已開墾地先狂熱 10 秒（每秒 +1） */
function updateFarmers(w: World, ctx: StepContext): void {
  const periods = ctx.data.units.farmer.periodMsByLevel;
  for (const a of Object.values(w.actors)) {
    if (a.kind !== 'farmer' || a.loc.c !== 'board' || !a.farm) continue;
    a.farm.timer += 1;
    const crazy = a.farm.crazy > 0;
    if (crazy) a.farm.crazy -= 1;
    const period = crazy ? ticks(1000) : ticks(periods[a.level - 1] ?? 20000);
    if (a.farm.timer < period) continue;
    a.farm.timer = 0;
    const gold = w.itemState.silt[a.side] ? Math.round(1 * ctx.data.units.farmer.siltGoldMultiplier * 10) / 10 : 1;
    w.camps[a.side].gold += gold;
  }
}

/** 農民移動到地圖上時呼叫：已開墾地進入狂熱，待開墾地正常耕作 */
export function onFarmerPlaced(w: World, a: Actor): void {
  if (a.kind !== 'farmer' || a.loc.c !== 'board') return;
  a.farm = { timer: 0, crazy: w.kind[a.loc.x]![a.loc.y] === 1 ? ticks(10000) : 0 };
}

// ---------------- 洛陽鏟、摸金校尉 ----------------

function superShovel(w: World, side: Side, ctx: StepContext): void {
  const i = side === 0 ? freeSlot(w, side) : -1;
  if (i >= 0) {
    const id = allocId(w);
    w.actors[id] = { id, side, token: 'shovel', kind: 'shovel', level: 1, loc: { c: 'incoming', i }, cooldown: 0, generalId: null, exp: 0 };
    w.camps[side].slots[i] = id;
    schedule(w, ticks(500), { kind: 'enterSlot', actorId: id });
    return;
  }
  let last: { x: number; y: number } | null = null;
  for (let x = 0; x < w.kind.length; x++) for (let y = 0; y < w.kind[x]!.length; y++) if (w.kind[x]![y] === 2 && w.camp[x]![y] === side && w.board[x]![y] == null) last = { x, y };
  if (last) expandCell(w, side, last.x, last.y, ctx);
}

/** 開墾一格；摸金校尉時順便挖出寶箱（1–10 戰鬥資金） */
export function expandCell(w: World, side: Side, x: number, y: number, ctx: StepContext): void {
  w.kind[x]![y] = 1;
  ctx.events.push({ type: 'expanded', x, y });
  if (w.itemState.goldSeeker[side]) {
    const gold = 1 + nextInt(w.rng, 'combat', 10);
    w.camps[side].gold += gold;
    ctx.events.push({ type: 'skill', side, name: `寶箱 +${gold}`, x: x * CELL + CELL / 2, y: y * CELL + CELL / 2 });
  }
}

// ---------------- 陷阱、地雷、隕石、推土車 ----------------

function cellOf(x: number, y: number) {
  return { cx: Math.floor(x / CELL), cy: Math.floor(y / CELL) };
}

function updateTraps(w: World, ctx: StepContext): void {
  for (const s of Object.values(w.skills)) {
    if (s.kind === 'trap') {
      if (s.fuse > 0) {
        s.fuse -= 1;
        if (s.fuse === 0) {
          // 地雷爆炸：60px 內所有敵人，不分陣營；普通敵人斃命、Boss 扣 10% 最大血量
          delete w.skills[s.id];
          ctx.events.push({ type: 'blast', x: s.x, y: s.y, r: 60 });
          for (const e of Object.values(w.enemies)) {
            if (Math.hypot(e.x - s.x, e.y - s.y) > 60) continue;
            damageEnemy(w, e, e.boss ? 0.1 * maxHpOf(w, e) : e.hp, null, ctx);
          }
        }
        continue;
      }
      const { cx, cy } = cellOf(s.x, s.y);
      for (const e of Object.values(w.enemies)) {
        const c = cellOf(e.x, e.y);
        if (c.cx !== cx || c.cy !== cy) continue;
        if (s.mine) {
          s.fuse = ticks(70);
        } else if (e.side === s.side) {
          // 陷阱只抓一隻，限制 5 秒
          applyBuff(w, e.id, BUFF.limit, 1, { timeMs: 5000 }, ctx);
          delete w.skills[s.id];
        } else continue;
        break;
      }
    } else if (s.kind === 'dozer') {
      const path = w.paths[s.side];
      if (!s.active) {
        // 有敵人抵達倒數第 2 個路點時出發
        if (Object.values(w.enemies).some((e) => e.side === s.side && e.pathIdx >= path.length - 2)) s.active = true;
        continue;
      }
      const step = (50 * TICK_MS) / 1000;
      const target = path[Math.max(0, s.pathIdx - 1)]!;
      const d = Math.hypot(target.x - s.x, target.y - s.y);
      if (d <= step) {
        s.x = target.x;
        s.y = target.y;
        if (s.pathIdx > 0) s.pathIdx -= 1;
      } else {
        s.x += ((target.x - s.x) / d) * step;
        s.y += ((target.y - s.y) / d) * step;
      }
      if (s.pathIdx === 0) {
        s.fade -= 1;
        if (s.fade <= 0) delete w.skills[s.id];
      }
      // 半格內的敵人被一起推回
      for (const e of Object.values(w.enemies)) {
        if (e.side !== s.side || Math.hypot(e.x - s.x, e.y - s.y) >= CELL / 2) continue;
        e.x = s.x;
        e.y = s.y;
        e.pathIdx = Math.max(1, s.pathIdx);
      }
    }
  }
}

/** 隕石：有敵人走到倒數第 3 個路點時，對最後 10 個路格各落一顆，冷卻 300 秒 */
function checkMeteor(w: World, ctx: StepContext): void {
  for (const side of [0, 1] as const) {
    if (!hasItem(w, side, ITEM.meteor) || w.itemState.meteorCd[side] > 0) continue;
    const path = w.paths[side];
    if (!Object.values(w.enemies).some((e) => e.side === side && e.pathIdx >= path.length - 3)) continue;
    w.itemState.meteorCd[side] = ticks(300_000);
    const cells = path.slice(-10).map((p) => ({ x: p.x + (rand(w) * 0.6 - 0.3) * CELL, y: p.y + (rand(w) * 0.6 - 0.3) * CELL }));
    for (let i = cells.length - 1; i > 0; i--) {
      const j = nextInt(w.rng, 'combat', i + 1);
      [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    }
    let t = 0;
    for (const c of cells) {
      t += 50 + nextInt(w.rng, 'combat', 50);
      schedule(w, ticks(t + 800 + rand(w) * 400), { kind: 'itemFx', side, itemId: ITEM.meteor, targetId: 0, x: c.x, y: c.y });
    }
    ctx.events.push({ type: 'skill', side, name: '隕石', x: path[path.length - 1]!.x, y: path[path.length - 1]!.y });
  }
}

// ---------------- 主動道具 ----------------

function actorAtLoc(w: World, side: Side, to: BoardLoc | SlotLoc): Actor | undefined {
  const id = to.c === 'board' ? w.board[to.x]?.[to.y] : w.camps[side].slots[to.i];
  return id == null ? undefined : w.actors[id];
}

function isEntryOrEnd(w: World, x: number, y: number, data: GameData): boolean {
  const p = data.maps.maps[w.mapId]!.points;
  return [p.playerEntry, p.playerPathEnd, p.aiEntry, p.aiPathEnd].some((c) => c.x === x && c.y === y);
}

function unitMaxed(w: World, a: Actor, data: GameData): boolean {
  if (a.kind === 'soldier' || a.kind === 'farmer') return a.level >= 5;
  if (a.generalId !== null) {
    const g = w.generals[a.generalId];
    return !!g && g.level >= data.generals.generals[g.type]!.maxLevel;
  }
  return false;
}

/** 道具驗證（原版 dn.validate 依序檢查，第一個失敗即回傳） */
export function validateItem(w: World, side: Side, slot: number, to: BoardLoc | SlotLoc | null, data: GameData): Result {
  const it = w.items[side][slot];
  if (!it) return no('沒有這個道具');
  const def = data.items.items[it.itemId];
  if (!def || !def.active) return no('被動道具不能使用');
  if (it.cd > 0) return no('道具冷卻中');
  const a = to ? actorAtLoc(w, side, to) : undefined;
  const own = (x: number, y: number) => w.camp[x]?.[y] === side;
  switch (it.itemId) {
    case ITEM.shovel:
      if (to?.c !== 'board' || !own(to.x, to.y) || w.kind[to.x]![to.y] !== 2) return no('不是擴展格');
      if (w.board[to.x]![to.y] != null) return no('請先移開格子上的單位');
      return ok;
    case ITEM.bulldozer:
      return ok;
    case ITEM.writingBrush:
    case ITEM.trainingSpell:
    case ITEM.upLvlSpell:
    case ITEM.attSpeedSpell:
    case ITEM.trashCan:
    case ITEM.longRange: {
      if (!to) return no('非戰鬥區域');
      if (!a || a.side !== side || a.loc.c === 'incoming') return no('無單位');
      if (to.c === 'board' && !own(to.x, to.y)) return no('陣營不匹配');
      if (a.kind === 'farmer' && it.itemId !== ITEM.trainingSpell && it.itemId !== ITEM.upLvlSpell) return no('不能對農民');
      if (a.kind === 'shovel') return no('沒有文字');
      if (it.itemId === ITEM.writingBrush && a.generalId !== null && (w.generals[a.generalId]?.busyUntil ?? 0) > w.tick) return no('技能施放中不能使用');
      if ((it.itemId === ITEM.trainingSpell || it.itemId === ITEM.upLvlSpell) && unitMaxed(w, a, data)) return no('滿級不可使用');
      if (it.itemId === ITEM.trainingSpell && a.level > 4) return no('等級過高');
      if (it.itemId === ITEM.attSpeedSpell && a.kind === 'name' && a.generalId === null) return no('只能士兵或武將');
      if (it.itemId === ITEM.longRange) {
        const g = a.generalId !== null ? w.generals[a.generalId] : undefined;
        const ranged = a.token === 'bow' || (g && data.generals.generals[g.type]!.weaponType === 0);
        if (!ranged) return no('只能遠程');
        if (hasBuff(w, g ? g.id : a.id, BUFF.attRange)) return no('已有此效果');
      }
      return ok;
    }
    case ITEM.lifePill:
      return ok;
    case ITEM.inkstone:
      return to?.c === 'board' ? ok : no('非戰鬥區域');
    case ITEM.trap:
    case ITEM.landmine: {
      if (to?.c !== 'board') return no('非戰鬥區域');
      if (w.kind[to.x]![to.y] !== 0) return no('不是道路');
      if (it.itemId === ITEM.trap && !own(to.x, to.y)) return no('陣營不匹配');
      if (isEntryOrEnd(w, to.x, to.y, data)) return no('不能出入口');
      const busy = Object.values(w.skills).some((s) => s.kind === 'trap' && cellOf(s.x, s.y).cx === to.x && cellOf(s.x, s.y).cy === to.y);
      return busy ? no('格子不為空') : ok;
    }
  }
  return no('這個道具不能使用');
}

/** 使用主動道具：驗證通過後套用效果與冷卻 */
export function useItem(w: World, side: Side, slot: number, to: BoardLoc | SlotLoc | null, ctx: StepContext): Result {
  const v = validateItem(w, side, slot, to, ctx.data);
  if (!v.ok) return v;
  const it = w.items[side][slot]!;
  const def = ctx.data.items.items[it.itemId]!;
  const a = to ? actorAtLoc(w, side, to) : undefined;
  const consume = () => w.items[side].splice(slot, 1);
  const startCd = () => (it.cd = ticks(def.cooldownMs ?? 0));
  const cx = to?.c === 'board' ? to.x * CELL + CELL / 2 : 0;
  const cy = to?.c === 'board' ? to.y * CELL + CELL / 2 : 0;
  ctx.events.push({ type: 'skill', side, name: def.name, x: cx || 320, y: cy || 400 });
  switch (it.itemId) {
    case ITEM.shovel:
      expandCell(w, side, (to as BoardLoc).x, (to as BoardLoc).y, ctx);
      consume();
      return ok;
    case ITEM.bulldozer: {
      const path = w.paths[side];
      const p = path[path.length - 2]!;
      const id = allocId(w);
      w.skills[id] = { id, kind: 'dozer', side, pathIdx: path.length - 2, x: p.x, y: p.y, active: false, fade: ticks(5000) };
      consume();
      return ok;
    }
    case ITEM.writingBrush:
    case ITEM.trainingSpell:
    case ITEM.upLvlSpell:
    case ITEM.attSpeedSpell:
    case ITEM.longRange:
      schedule(w, ticks(600), { kind: 'itemFx', side, itemId: it.itemId, targetId: a!.id, x: 0, y: 0 });
      startCd();
      return ok;
    case ITEM.trashCan: {
      // 垃圾桶：回收單位，本局資金 + 該單位等級
      const target = a!;
      const level = target.generalId !== null ? (w.generals[target.generalId]?.level ?? target.level) : target.level;
      removeUnit(w, target);
      w.camps[side].gold += level;
      startCd();
      return ok;
    }
    case ITEM.lifePill:
      schedule(w, ticks(800), { kind: 'itemFx', side, itemId: it.itemId, targetId: 0, x: 0, y: 0 });
      it.uses += 1;
      // 每 10 次成功送達後才進冷卻（原版前 9 次不重設）
      if (it.uses % 10 === 0) startCd();
      return ok;
    case ITEM.inkstone:
      schedule(w, ticks(500), { kind: 'itemFx', side, itemId: it.itemId, targetId: 0, x: cx, y: cy });
      startCd();
      return ok;
    case ITEM.trap:
    case ITEM.landmine: {
      const id = allocId(w);
      const lane = w.camp[(to as BoardLoc).x]![(to as BoardLoc).y] as Side;
      w.skills[id] = { id, kind: 'trap', side: lane, owner: side, mine: it.itemId === ITEM.landmine, x: cx, y: cy, fuse: 0 };
      startCd();
      return ok;
    }
  }
  return no('這個道具不能使用');
}

function removeUnit(w: World, a: Actor): void {
  dissolveGeneralOf(w, a);
  const l = a.loc;
  if (l.c === 'board' && w.board[l.x]![l.y] === a.id) w.board[l.x]![l.y] = null;
  else if ((l.c === 'slot' || l.c === 'incoming') && w.camps[a.side].slots[l.i] === a.id) w.camps[a.side].slots[l.i] = null;
  delete w.actors[a.id];
  delete w.buffs[a.id];
}

/** 延遲生效的道具效果 */
export function resolveItemFx(w: World, f: { side: Side; itemId: number; targetId: number; x: number; y: number }, ctx: StepContext): void {
  const a = w.actors[f.targetId];
  switch (f.itemId) {
    case ITEM.writingBrush: {
      if (!a) return;
      // 毛筆：依牌庫重複數加權換成另一個字（排除原字與鏟），保留等級與位置
      const cands = ctx.data.deck.baseDeck.filter((t) => t !== a.token && t !== 'shovel');
      const token = cands[nextInt(w.rng, 'combat', cands.length)]!;
      dissolveGeneralOf(w, a);
      a.token = token;
      a.kind = ['blade', 'bow', 'spear', 'cavalry'].includes(token) ? 'soldier' : 'name';
      if (a.kind === 'name') a.level = 1;
      tryFormGeneral(w, a, ctx);
      return;
    }
    case ITEM.trainingSpell:
    case ITEM.upLvlSpell: {
      if (!a) return;
      let delta = 1;
      if (f.itemId === ITEM.trainingSpell) {
        if (a.level === 3) delta = rand(w) < 0.7 ? 1 : -1;
        else if (a.level === 4) delta = rand(w) < 0.6 ? 1 : -1;
      }
      if (a.generalId !== null) {
        // 武將字片：走武將升級流程
        const g = w.generals[a.generalId];
        if (g) gainExp(w, g, delta > 0 ? feedAmount(g, ctx.data) : -feedAmount(g, ctx.data), ctx);
        return;
      }
      if (a.kind === 'name') return;
      a.level = Math.min(5, Math.max(1, a.level + delta));
      if (delta > 0) onUnitLevelUp(w, a.id);
      ctx.events.push({ type: 'merged', actorId: a.id, level: a.level });
      return;
    }
    case ITEM.attSpeedSpell: {
      if (!a) return;
      const id = a.generalId ?? a.id;
      applyBuff(w, id, BUFF.attSpeed, 0.4, { percent: true, timeMs: -1 }, ctx);
      return;
    }
    case ITEM.longRange: {
      if (!a) return;
      applyBuff(w, a.generalId ?? a.id, BUFF.attRange, 1, { percent: true, timeMs: -1 }, ctx);
      return;
    }
    case ITEM.lifePill: {
      // 包子：55% 自己阿斗 +1 命、45% -1 命
      const camp = w.camps[f.side];
      camp.lives += rand(w) < 0.55 ? 1 : -1;
      ctx.events.push({ type: 'adouHit', side: f.side, lives: camp.lives });
      return;
    }
    case ITEM.inkstone: {
      // 硯台：落點 120px 內的對方普通兵與武將攻速 -20%，5 秒
      const opp = other(f.side);
      ctx.events.push({ type: 'blast', x: f.x, y: f.y, r: 120 });
      for (const u of Object.values(w.actors)) {
        if (u.side !== opp || u.kind !== 'soldier' || u.loc.c !== 'board') continue;
        if (Math.hypot(u.loc.x * CELL + CELL / 2 - f.x, u.loc.y * CELL + CELL / 2 - f.y) <= 120 + CELL / 2) {
          applyBuff(w, u.id, BUFF.attSpeed, -0.2, { percent: true, timeMs: 5000 }, ctx);
        }
      }
      for (const g of Object.values(w.generals)) {
        const c = g.side === opp ? generalCenter(w, g) : null;
        if (c && Math.hypot(c.x - f.x, c.y - f.y) <= 120 + CELL / 2) applyBuff(w, g.id, BUFF.attSpeed, -0.2, { percent: true, timeMs: 5000 }, ctx);
      }
      return;
    }
    case ITEM.meteor: {
      ctx.events.push({ type: 'blast', x: f.x, y: f.y, r: CELL });
      const dmg = enemyHp(w, w.wave.wave, ctx);
      for (const e of Object.values(w.enemies)) {
        if (e.side === f.side && Math.hypot(e.x - f.x, e.y - f.y) <= CELL) damageEnemy(w, e, dmg, null, ctx);
      }
      return;
    }
  }
}

// ---------------- 招賢榜、升職令、降妖符 ----------------

/** 抽到名字字時：有招賢榜的一方再移除一張同字 */
export function onNameDrawn(w: World, side: Side, token: string): void {
  if (!w.itemState.recruitBoost[side]) return;
  const i = w.camps[side].deck.indexOf(token);
  if (i >= 0) w.camps[side].deck.splice(i, 1);
}

/** 升職令：刷新欄新建的 1 級普通兵有 5/10/15% 直接 2 級 */
export function promotionChance(w: World, side: Side, data: GameData): number {
  const it = hasItem(w, side, ITEM.promotionOrder);
  if (!it) return 0;
  return (data.items.items[ITEM.promotionOrder]!.levels?.[it.level - 1]?.promoteChancePct ?? 0) / 100;
}

/** 降妖符：自己防區的 Boss 施法時 50% 失敗並反噬 10%–20% 最大血量；回傳 true 表示施法被攔截 */
export function exorcismBlocks(w: World, boss: Enemy, ctx: StepContext): boolean {
  if (!hasItem(w, boss.side, ITEM.exorcismSpell)) return false;
  if (rand(w) > 0.5) return false;
  const ratio = 0.1 + rand(w) * 0.1;
  damageEnemy(w, boss, maxHpOf(w, boss) * ratio, null, ctx);
  ctx.events.push({ type: 'skill', side: boss.side, name: '降妖', x: boss.x, y: boss.y });
  return true;
}

// ---------------- AI 道具 ----------------

/** AI 開局道具（原版 Zh.GB）：依本日局數抽總數，主動／被動分配後各自不重複抽 */
export function generateAiItems(data: GameData, rng: () => number, firstDay: boolean, roundOfDay: number): { id: number; level: number }[] {
  const table = firstDay ? data.items.aiItemCountFirstDay : data.items.aiItemCountLater;
  const [min, max] = table[Math.min(table.length, Math.max(1, roundOfDay)) - 1]!;
  const total = min + Math.floor(rng() * (max - min + 1));
  const lo = Math.max(0, total - 6);
  const hi = Math.min(total + 1, 3);
  const active = hi > lo ? lo + Math.floor(rng() * (hi - lo)) : 0;
  const pick = (pool: number[], n: number) => {
    const out: number[] = [];
    const p = [...pool];
    while (out.length < n && p.length > 0) out.push(p.splice(Math.floor(rng() * p.length), 1)[0]!);
    return out;
  };
  const items = data.items.items;
  const activePool = items.filter((i) => i.active && ![ITEM.shovel, ITEM.bulldozer, ITEM.marchPill].includes(i.id as 0)).map((i) => i.id);
  const passivePool = items.filter((i) => !i.active).map((i) => i.id);
  return [...pick(activePool, active), ...pick(passivePool, total - active)].map((id) => {
    const lv = items[id]!.levels;
    return { id, level: lv ? 1 + Math.floor(rng() * lv.length) : 1 };
  });
}

/** AI 使用道具（原版 KO）：至少相隔 5 秒，從冷卻完成的主動道具隨機挑一個，依類型選目標 */
export function aiUseItem(w: World, ctx: StepContext): void {
  if (w.tick - w.itemState.lastAiItemTick < ticks(5000)) return;
  const usable = w.items[1].map((it, slot) => ({ it, slot })).filter(({ it }) => ctx.data.items.items[it.itemId]!.active && it.cd <= 0);
  if (usable.length === 0) return;
  const { it, slot } = usable[nextInt(w.rng, 'ai', usable.length)]!;
  const pickOwn = (pred: (a: Actor) => boolean): BoardLoc | null => {
    const list = Object.values(w.actors).filter((a) => a.side === 1 && a.loc.c === 'board' && pred(a));
    if (list.length === 0) return null;
    const a = list[nextInt(w.rng, 'ai', list.length)]!;
    return a.loc as BoardLoc;
  };
  let to: BoardLoc | null = null;
  switch (it.itemId) {
    case ITEM.trainingSpell:
    case ITEM.upLvlSpell:
    case ITEM.attSpeedSpell:
      to = pickOwn((a) => a.kind === 'soldier' || a.generalId !== null);
      break;
    case ITEM.longRange:
      to = pickOwn((a) => a.token === 'bow');
      break;
    case ITEM.writingBrush:
      to = pickOwn((a) => a.kind === 'name' && a.generalId === null);
      break;
    case ITEM.trashCan:
      to = pickOwn((a) => a.kind === 'name' && a.generalId === null);
      break;
    case ITEM.inkstone: {
      // 丟在玩家半場
      const half = w.kind[0]!.length / 2;
      to = { c: 'board', x: nextInt(w.rng, 'ai', w.kind.length), y: half + nextInt(w.rng, 'ai', half) };
      break;
    }
    case ITEM.trap:
    case ITEM.landmine: {
      const road = w.paths[1].slice(2, -2).map((p) => ({ c: 'board' as const, x: Math.floor(p.x / CELL), y: Math.floor(p.y / CELL) }));
      to = road.length ? road[nextInt(w.rng, 'ai', road.length)]! : null;
      break;
    }
    case ITEM.lifePill:
      to = { c: 'board', x: 3, y: 3 };
      break;
  }
  const res = useItem(w, 1, slot, to, ctx);
  if (res.ok) w.itemState.lastAiItemTick = w.tick;
}

