// 純視覺狀態：出手衝刺、命中閃白、墨點粒子、畫面震動。只由對局事件驅動，不寫回 World，
// 也不用對局亂數（用 Math.random），因此不影響重播與存檔。
import type { BattleEvent, World } from '../domain/battle/types';

const MAX_PARTICLES = 240;
/** 出手衝刺：前 70ms 衝出，150ms 收回 */
const LUNGE_OUT = 70;
const LUNGE_BACK = 150;
const HIT_FLASH_MS = 140;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
  /** dot：墨點；spark：命中火花（短線） */
  kind: 'dot' | 'spark';
  tone: 'ink' | 'seal' | 'gold';
}

interface Lunge {
  born: number;
  dx: number;
  dy: number;
  /** 衝刺距離（像素）；負值為後座力 */
  dist: number;
}

export class BattleFx {
  readonly particles: Particle[] = [];
  private readonly lunges = new Map<string, Lunge>();
  private readonly hits = new Map<number, number>();
  private readonly seenShots = new Set<number>();
  private shake: { born: number; mag: number; dur: number } | null = null;
  /** 我方阿斗受傷：畫面四周泛紅 */
  hurtAt = -1e9;
  /** 減少特效：關閉震動、衝刺、浮動與粒子 */
  reduced = false;

  onEvents(events: BattleEvent[], w: World, now: number): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'attack': {
          if (ev.kind === 'arrow') {
            if (!this.reduced) this.spark(ev.tx, ev.ty, now, 3, 'gold');
            break;
          }
          const len = Math.hypot(ev.tx - ev.x, ev.ty - ev.y) || 1;
          const dist = ev.kind === 'melee' ? 14 : ev.kind === 'spear' ? 10 : 0;
          this.lunges.set(srcKey(ev.src), { born: now, dx: (ev.tx - ev.x) / len, dy: (ev.ty - ev.y) / len, dist });
          break;
        }
        case 'damage':
          this.hits.set(ev.enemyId, now);
          if (!this.reduced) this.spark(ev.x, ev.y, now, 2, 'seal');
          break;
        case 'enemyDied':
          this.hits.delete(ev.enemyId);
          if (!this.reduced) this.splash(ev.x, ev.y, now);
          break;
        case 'adouHit':
          if (ev.side === 0) {
            this.hurtAt = now;
            this.startShake(now, 9, 320);
          }
          break;
        case 'bossSpawn':
          if (ev.side === 0) this.startShake(now, 6, 400);
          break;
        case 'blast':
          if (ev.r >= 100) this.startShake(now, 4, 220);
          break;
      }
    }
    // 新出現的箭：出手者往後一頓（後座力）
    for (const p of Object.values(w.projectiles)) {
      if (this.seenShots.has(p.id)) continue;
      this.seenShots.add(p.id);
      const t = w.enemies[p.targetId];
      if (!t) continue;
      const len = Math.hypot(t.x - p.x, t.y - p.y) || 1;
      this.lunges.set(srcKey(p.src), { born: now, dx: (t.x - p.x) / len, dy: (t.y - p.y) / len, dist: -5 });
    }
    if (this.seenShots.size > 512) for (const id of this.seenShots) if (!w.projectiles[id]) this.seenShots.delete(id);
  }

  /** 每幀清掉過期狀態並推進粒子 */
  tick(now: number, dtMs: number): void {
    for (const [k, l] of this.lunges) if (now - l.born > LUNGE_OUT + LUNGE_BACK) this.lunges.delete(k);
    for (const [k, t] of this.hits) if (now - t > HIT_FLASH_MS) this.hits.delete(k);
    const dt = Math.min(50, dtMs) / 1000;
    let n = 0;
    for (const p of this.particles) {
      if (now - p.born > p.life) continue;
      // 墨點逐漸減速
      const drag = p.kind === 'dot' ? 0.9 : 1;
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      this.particles[n++] = p;
    }
    this.particles.length = n;
    if (this.shake && now - this.shake.born > this.shake.dur) this.shake = null;
  }

  /** 出手衝刺的位移；sourceKey 由 actorKey / generalKey 產生 */
  offset(key: string, now: number): { x: number; y: number } {
    const l = this.lunges.get(key);
    if (!l || this.reduced || l.dist === 0) return ZERO;
    const t = now - l.born;
    const k = t < LUNGE_OUT ? easeOut(t / LUNGE_OUT) : Math.max(0, 1 - (t - LUNGE_OUT) / LUNGE_BACK);
    return { x: l.dx * l.dist * k, y: l.dy * l.dist * k };
  }

  /** 橫掃出手時單位放大一下：回傳縮放倍率 */
  pulse(key: string, now: number): number {
    const l = this.lunges.get(key);
    if (!l || l.dist !== 0) return 1;
    const t = (now - l.born) / (LUNGE_OUT + LUNGE_BACK);
    return 1 + 0.12 * Math.sin(Math.min(1, t) * Math.PI);
  }

  /** 命中閃白強度 0..1 */
  flash(enemyId: number, now: number): number {
    const t = this.hits.get(enemyId);
    return t === undefined ? 0 : Math.max(0, 1 - (now - t) / HIT_FLASH_MS);
  }

  shakeOffset(now: number): { x: number; y: number } {
    if (!this.shake || this.reduced) return ZERO;
    const k = 1 - (now - this.shake.born) / this.shake.dur;
    if (k <= 0) return ZERO;
    const m = this.shake.mag * k * k;
    return { x: (Math.random() * 2 - 1) * m, y: (Math.random() * 2 - 1) * m };
  }

  private startShake(now: number, mag: number, dur: number): void {
    if (this.shake && this.shake.mag * (1 - (now - this.shake.born) / this.shake.dur) > mag) return;
    this.shake = { born: now, mag, dur };
  }

  private push(p: Particle): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  private spark(x: number, y: number, now: number, n: number, tone: Particle['tone']): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 140 + Math.random() * 120;
      this.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now, life: 160, size: 2, kind: 'spark', tone });
    }
  }

  /** 敵人倒下：一圈墨點向外濺開 */
  private splash(x: number, y: number, now: number): void {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + Math.random() * 0.5;
      const v = 60 + Math.random() * 150;
      this.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now, life: 420 + Math.random() * 200, size: 2.5 + Math.random() * 3.5, kind: 'dot', tone: 'ink' });
    }
  }
}

const ZERO = { x: 0, y: 0 } as const;

export const actorKey = (id: number) => `a${id}`;
export const generalKey = (id: number) => `g${id}`;
function srcKey(src: { kind: 'actor' | 'general'; id: number }): string {
  return src.kind === 'actor' ? actorKey(src.id) : generalKey(src.id);
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
