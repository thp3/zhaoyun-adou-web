import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameData, loadGameData } from '../src/data';

const d = gameData;
const count = <T>(xs: T[], pred: (x: T) => boolean) => xs.filter(pred).length;

describe('資料表通過 schema 與跨表檢查', () => {
  it('loadGameData 不丟錯', () => {
    expect(() => loadGameData()).not.toThrow();
  });
});

describe('數量與原版一致', () => {
  it('108 張牌庫：刀21 弓19 槍18 騎17 鏟11、名字字22', () => {
    const deck = d.deck.baseDeck;
    expect(deck).toHaveLength(108);
    expect(count(deck, (t) => t === 'blade')).toBe(21);
    expect(count(deck, (t) => t === 'bow')).toBe(19);
    expect(count(deck, (t) => t === 'spear')).toBe(18);
    expect(count(deck, (t) => t === 'cavalry')).toBe(17);
    expect(count(deck, (t) => t === 'shovel')).toBe(11);
    const nameIds = new Set(d.tokens.tokens.filter((t) => t.kind === 'name').map((t) => t.id));
    expect(count(deck, (t) => nameIds.has(t))).toBe(22);
  });

  it('4 張 8×10 地圖', () => {
    expect(d.maps.maps.map((m) => m.name)).toEqual(['巨鹿', '雲夢澤', '虎牢關', '赤壁']);
  });

  it('12 武將：6 名 5 級、6 名 3 級', () => {
    const gs = d.generals.generals;
    expect(gs).toHaveLength(12);
    expect(gs.filter((g) => g.maxLevel === 5).map((g) => g.name).sort()).toEqual(
      ['劉備', '張飛', '趙雲', '關羽', '馬超', '黃忠'].sort(),
    );
  });

  it('武將名字字都在牌庫裡', () => {
    const deck = new Set(d.deck.baseDeck);
    for (const g of d.generals.generals) for (const c of g.chars) expect(deck.has(c)).toBe(true);
  });

  it('7 技能、12 Boss（每圖 3 名）、20 buff、25 道具、44 武器＋4 預設、54 段位', () => {
    expect(d.generals.skills).toHaveLength(7);
    expect(d.waves.bosses).toHaveLength(12);
    for (let m = 0; m < 4; m++) expect(count(d.waves.bosses, (b) => b.mapId === m)).toBe(3);
    expect(d.buffs.buffs).toHaveLength(20);
    expect(d.items.items).toHaveLength(25);
    expect(d.weapons.weapons).toHaveLength(44);
    expect(d.weapons.defaults).toHaveLength(4);
    expect(d.ranks.ranks).toHaveLength(54);
  });

  it('主動道具數與被動道具數', () => {
    // cd != -1 為主動（含鏟子、推土車、行軍丹這類特殊項）
    expect(count(d.items.items, (i) => i.active)).toBe(13);
    expect(count(d.items.items, (i) => !i.active)).toBe(12);
  });
});

describe('關鍵規則數值', () => {
  it('20 波出兵數', () => {
    expect(d.waves.spawnCountByWave).toEqual([
      10, 11, 12, 13, 15, 16, 18, 19, 21, 24, 26, 29, 31, 35, 38, 42, 46, 51, 56, 61,
    ]);
    expect(d.waves.spawnIntervalMs).toBe(1500);
    expect(d.waves.intermissionMs).toBe(5000);
    expect(d.waves.initialDelayMs).toBe(10000);
  });

  it('Boss 判定波次與機率', () => {
    expect(d.waves.bossWaves).toEqual([3, 6, 9, 12, 15, 18]);
    expect(d.waves.bossChance).toEqual([0.1, 0.2, 0.3, 0.5, 0.9, 1]);
  });

  it('體力：上限30、5分鐘回1、每局5', () => {
    expect(d.economy.stamina.max).toBe(30);
    expect(d.economy.stamina.recoverIntervalMs).toBe(300_000);
    expect(d.economy.stamina.battleCost).toBe(5);
  });

  it('開局資金與征兵價格', () => {
    expect(d.economy.battleStart.playerGold).toBe(20);
    expect(d.economy.battleStart.aiGold).toBe(30);
    expect(d.deck.recruit.initialCost).toBe(10);
    expect(d.deck.recruit.costIncrement).toBe(2);
  });

  it('AI 決策間隔與波次補助', () => {
    expect(d.ai.decisionIntervalMs).toEqual([2000, 1500, 1000, 500]);
    expect(d.ai.waveBonusWaves).toEqual([3, 5, 8, 11, 14, 17]);
    expect(d.ai.waveBonusGoldByDifficulty).toEqual([0, 0, 10, 20]);
  });

  it('地圖路徑端點皆為道路且屬正確陣營', () => {
    for (const m of d.maps.maps) {
      const { playerPathStart, playerPathEnd, aiPathStart, aiPathEnd } = m.points;
      expect(m.camp[playerPathStart.x]![playerPathStart.y]).toBe(0);
      expect(m.camp[playerPathEnd.x]![playerPathEnd.y]).toBe(0);
      expect(m.camp[aiPathStart.x]![aiPathStart.y]).toBe(1);
      expect(m.camp[aiPathEnd.x]![aiPathEnd.y]).toBe(1);
    }
  });

  it('顯示文字為繁體', () => {
    const text = JSON.stringify([d.items.items, d.generals, d.ranks.ranks, d.weapons.weapons, d.waves.bosses]);
    for (const ch of ['铲', '张', '关', '军', '剑', '枪', '骑', '马', '赵']) expect(text).not.toContain(ch);
  });
});

const SRC = process.env.GAME_SOURCE_DIR ?? 'D:/gathergame';
describe.skipIf(!existsSync(SRC))('抽取腳本可重現', () => {
  it('重跑結果與 data/ 完全相同', () => {
    const out = mkdtempSync(join(tmpdir(), 'zyad-extract-'));
    try {
      execFileSync(process.execPath, ['tools/extract/extract.mjs', '--src', SRC, '--out', out], { stdio: 'pipe' });
      for (const f of readdirSync('data').filter((n) => n.endsWith('.json'))) {
        expect(readFileSync(join(out, f), 'utf8'), f).toBe(readFileSync(join('data', f), 'utf8'));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);
});
