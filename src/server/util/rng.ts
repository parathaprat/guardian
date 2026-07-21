/**
 * Seeded PRNG (mulberry32).
 *
 * Every stochastic decision in the world model runs through one of these. The
 * whole "prove it got smarter" claim rests on being able to replay an identical
 * event stream, so nothing in simulation or memory may touch Math.random().
 */

/** FNV-1a, 32-bit. Used to turn string salts into stream seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  /** The seed this stream was constructed with — forks derive from it, not from live state. */
  readonly seed: number;
  private state: number;
  /** Box-Muller produces two normals per pass; the unused one is cached here. */
  private gaussSpare: number | null = null;

  constructor(seed: number) {
    const s = seed >>> 0;
    this.seed = s;
    this.state = s === 0 ? 0x9e3779b9 : s;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi <= lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty collection');
    return items[this.int(0, items.length - 1)];
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('Rng.weighted: empty collection');
    let total = 0;
    for (let i = 0; i < items.length; i++) total += Math.max(0, weights[i] ?? 0);
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i] ?? 0);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  gauss(mean: number, sd: number): number {
    if (this.gaussSpare !== null) {
      const v = this.gaussSpare;
      this.gaussSpare = null;
      return mean + sd * v;
    }
    // Guard against log(0) — next() can legitimately return exactly 0.
    const u1 = Math.max(1e-12, this.next());
    const u2 = this.next();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const a = mag * Math.cos(2 * Math.PI * u2);
    this.gaussSpare = mag * Math.sin(2 * Math.PI * u2);
    return mean + sd * a;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /**
   * An independent stream keyed off (parent seed, salt). Derived from the seed
   * rather than the current state so that subsystems consuming different amounts
   * of entropy can never perturb each other — that is what keeps a live tick
   * loop with jittery frame timing from changing the event stream.
   */
  fork(salt: number | string): Rng {
    const h = typeof salt === 'number' ? Math.imul(salt | 0, 0x9e3779b1) >>> 0 : hashString(salt);
    let m = (this.seed ^ h) >>> 0;
    m = Math.imul(m ^ (m >>> 16), 0x85ebca6b) >>> 0;
    m = Math.imul(m ^ (m >>> 13), 0xc2b2ae35) >>> 0;
    return new Rng((m ^ (m >>> 16)) >>> 0);
  }
}
