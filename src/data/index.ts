// 遊戲規則資料的唯一入口。其他模組只從這裡取資料，不直接 import data/*.json。
import type { z } from 'zod';
import aiJson from '../../data/ai.json';
import buffsJson from '../../data/buffs.json';
import deckJson from '../../data/deck.json';
import economyJson from '../../data/economy.json';
import generalsJson from '../../data/generals.json';
import itemsJson from '../../data/items.json';
import manifestJson from '../../data/manifest.json';
import mapsJson from '../../data/maps.json';
import ranksJson from '../../data/ranks.json';
import tokensJson from '../../data/tokens.json';
import unitsJson from '../../data/units.json';
import wavesJson from '../../data/waves.json';
import weaponsJson from '../../data/weapons.json';
import {
  AiFileSchema,
  BuffsFileSchema,
  DeckFileSchema,
  EconomyFileSchema,
  GeneralsFileSchema,
  ItemsFileSchema,
  ManifestSchema,
  MapsFileSchema,
  RanksFileSchema,
  TokensFileSchema,
  UnitsFileSchema,
  WavesFileSchema,
  WeaponsFileSchema,
} from './schemas';

const FILES = {
  manifest: [ManifestSchema, manifestJson],
  tokens: [TokensFileSchema, tokensJson],
  maps: [MapsFileSchema, mapsJson],
  deck: [DeckFileSchema, deckJson],
  units: [UnitsFileSchema, unitsJson],
  generals: [GeneralsFileSchema, generalsJson],
  waves: [WavesFileSchema, wavesJson],
  ai: [AiFileSchema, aiJson],
  items: [ItemsFileSchema, itemsJson],
  buffs: [BuffsFileSchema, buffsJson],
  weapons: [WeaponsFileSchema, weaponsJson],
  ranks: [RanksFileSchema, ranksJson],
  economy: [EconomyFileSchema, economyJson],
} as const;

type Files = typeof FILES;
export type GameData = { [K in keyof Files]: z.infer<Files[K][0]> };

export class DataError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'DataError';
  }
}

/** 驗證全部資料表與跨表引用；任何一項失敗都丟出 DataError，不回傳部分資料。 */
export function loadGameData(): GameData {
  const issues: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, [schema, json]] of Object.entries(FILES)) {
    const result = schema.safeParse(json);
    if (result.success) out[name] = result.data;
    else for (const issue of result.error.issues) issues.push(`${name}.${issue.path.join('.')}: ${issue.message}`);
  }
  if (issues.length > 0) throw new DataError('資料表格式錯誤', issues);
  const data = out as GameData;
  issues.push(...crossCheck(data));
  if (issues.length > 0) throw new DataError('資料表引用不一致', issues);
  return data;
}

function crossCheck(d: GameData): string[] {
  const issues: string[] = [];
  const tokenIds = new Set(d.tokens.tokens.map((t) => t.id));
  const checkToken = (where: string, id: string) => {
    if (!tokenIds.has(id)) issues.push(`${where}: 未知字牌 ${id}`);
  };
  d.deck.baseDeck.forEach((id, i) => checkToken(`deck.baseDeck.${i}`, id));
  d.deck.tutorial.secondRefreshFixed.forEach((id, i) => checkToken(`deck.tutorial.secondRefreshFixed.${i}`, id));
  d.generals.generals.forEach((g) => g.chars.forEach((c) => checkToken(`generals.${g.key}`, c)));

  const skillIds = new Set(d.generals.skills.map((s) => s.id));
  for (const g of d.generals.generals) {
    if (g.skill && !skillIds.has(g.skill.skill)) issues.push(`generals.${g.key}: 未知技能 ${g.skill.skill}`);
  }
  for (const m of d.maps.maps) {
    for (const [name, p] of Object.entries(m.points)) {
      if (m.kind[p.x]?.[p.y] !== 0) issues.push(`maps.${m.key}.${name}: (${p.x},${p.y}) 不是道路`);
    }
  }
  d.items.items.forEach((it, i) => {
    if (it.id !== i) issues.push(`items.${i}: id 應為 ${i}`);
  });
  for (const [key, count] of Object.entries(d.manifest.counts)) {
    if (count <= 0) issues.push(`manifest.counts.${key}: 不可為 0`);
  }
  return issues;
}

