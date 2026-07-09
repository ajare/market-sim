/**
 * Seeded PRNG with the surface area sim/*.py calls on a `random.Random`
 * instance (or the global `random` module). Built on mulberry32, so it is
 * NOT bit-for-bit compatible with Python's Mersenne Twister -- "same seed
 * -> same result" determinism here is scoped to within this app, matching
 * the spirit of the Python design (independent, reproducible streams), not
 * cross-language output parity.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  private nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A float in [0, 1), matching random.random(). */
  random(): number {
    return this.nextUint32() / 4294967296;
  }

  /** A float in [a, b], matching random.uniform(a, b). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** An integer in [a, b] inclusive, matching random.randint(a, b). */
  randint(a: number, b: number): number {
    return a + Math.floor(this.random() * (b - a + 1));
  }

  /** A uniformly random element, matching random.choice(seq). */
  choice<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("choice() called on an empty sequence");
    return arr[Math.floor(this.random() * arr.length)];
  }

  /** k distinct elements without replacement, matching random.sample(population, k). */
  sample<T>(arr: readonly T[], k: number): T[] {
    const pool = arr.slice();
    const n = pool.length;
    if (k > n) throw new Error("sample larger than population");
    const result: T[] = [];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(this.random() * (n - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
      result.push(pool[i]);
    }
    return result;
  }

  /** In-place Fisher-Yates shuffle, matching random.shuffle(seq). */
  shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  /** A normally-distributed float, matching random.gauss(mu, sigma). */
  gauss(mu: number, sigma: number): number {
    let u1 = this.random();
    while (u1 === 0) u1 = this.random();
    const u2 = this.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mu + sigma * z0;
  }
}
