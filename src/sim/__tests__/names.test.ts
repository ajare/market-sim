import { describe, it, expect } from "vitest";
import {
  MALE_FIRST_NAME_FRACTION, randomName,
  ENGLISH_NAMES, FRENCH_NAMES, SPANISH_NAMES, DUTCH_NAMES, PORTUGUESE_NAMES,
  type NamePool, type NameRng,
} from "../names";
import { Rng } from "../rng";

const POOLS: [string, NamePool][] = [
  ["English", ENGLISH_NAMES],
  ["French", FRENCH_NAMES],
  ["Spanish", SPANISH_NAMES],
  ["Dutch", DUTCH_NAMES],
  ["Portuguese", PORTUGUESE_NAMES],
];

describe("name generators", () => {
  it("provides exactly the five requested nationalities, each fully populated", () => {
    expect(POOLS.map(([n]) => n)).toEqual(["English", "French", "Spanish", "Dutch", "Portuguese"]);
    for (const [, pool] of POOLS) {
      expect(pool.maleFirstNames.length).toBeGreaterThan(0);
      expect(pool.femaleFirstNames.length).toBeGreaterThan(0);
      expect(pool.lastNames.length).toBeGreaterThan(0);
    }
  });

  it("generates a 'First Last' name drawn from the pool", () => {
    const rng = new Rng(1);
    for (const [, pool] of POOLS) {
      const [first, ...rest] = randomName(rng, pool).split(" ");
      const last = rest.join(" ");
      const allFirst = [...pool.maleFirstNames, ...pool.femaleFirstNames];
      expect(allFirst).toContain(first);
      expect(pool.lastNames).toContain(last);
    }
  });

  it("MALE_FIRST_NAME_FRACTION is 75%", () => {
    expect(MALE_FIRST_NAME_FRACTION).toBe(0.75);
  });

  it("draws a male first name ~75% of the time", () => {
    // Deterministic NameRng feeding evenly-spaced rolls across [0,1): exactly
    // 75% land below 0.75, so 75% of names must come from the male pool.
    const N = 1000;
    let cursor = 0;
    const rng: NameRng = {
      random: () => (cursor++ + 0.5) / N, // 0.0005, 0.0015, ... 0.9995
      choice: (arr) => arr[0], // deterministic pick so only the gender roll matters
    };
    const male = new Set(SPANISH_NAMES.maleFirstNames);
    let maleCount = 0;
    for (let i = 0; i < N; i++) {
      // Each randomName consumes one `random()` (gender roll) then two `choice()`.
      const first = randomName(rng, SPANISH_NAMES).split(" ")[0];
      if (male.has(first)) maleCount++;
    }
    expect(maleCount / N).toBeCloseTo(0.75, 2);
  });

  it("statistically lands near 75% male over the seeded RNG too", () => {
    const rng = new Rng(42);
    const male = new Set(DUTCH_NAMES.maleFirstNames);
    const N = 4000;
    let maleCount = 0;
    for (let i = 0; i < N; i++) {
      if (male.has(randomName(rng, DUTCH_NAMES).split(" ")[0])) maleCount++;
    }
    // Loose bound -- ~75% expected, allowing sampling noise.
    expect(maleCount / N).toBeGreaterThan(0.70);
    expect(maleCount / N).toBeLessThan(0.80);
  });
});
