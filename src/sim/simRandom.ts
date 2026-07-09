/**
 * The simulation's own shared, reseedable random stream -- mirrors Python's
 * global `random` module (as opposed to a dedicated `random.Random(seed)`
 * instance, which worldData.ts/routes.ts/names.ts each get their own of).
 * World's constructor reseeds this via seedSimRandom() when built with a
 * `seed`, exactly like `random.seed(seed)` in World.__init__.
 */
import { Rng } from "./rng";

let instance = new Rng(Date.now() ^ 0x2f6e2b1);

export function seedSimRandom(seed: number): void {
  instance = new Rng(seed);
}

export function randRandom(): number {
  return instance.random();
}

export function randUniform(a: number, b: number): number {
  return instance.uniform(a, b);
}

export function randInt(a: number, b: number): number {
  return instance.randint(a, b);
}

export function randChoice<T>(arr: readonly T[]): T {
  return instance.choice(arr);
}

export function randSample<T>(arr: readonly T[], k: number): T[] {
  return instance.sample(arr, k);
}

export function randShuffle<T>(arr: T[]): void {
  instance.shuffle(arr);
}

export function randGauss(mu: number, sigma: number): number {
  return instance.gauss(mu, sigma);
}
