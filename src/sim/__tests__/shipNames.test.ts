import { describe, it, expect } from "vitest";
import {
  randomShipName,
  ENGLISH_SHIP_NAMES, FRENCH_SHIP_NAMES, SPANISH_SHIP_NAMES, DUTCH_SHIP_NAMES, PORTUGUESE_SHIP_NAMES,
} from "../shipNames";
import { Rng } from "../rng";

const POOLS: [string, string[]][] = [
  ["English", ENGLISH_SHIP_NAMES],
  ["French", FRENCH_SHIP_NAMES],
  ["Spanish", SPANISH_SHIP_NAMES],
  ["Dutch", DUTCH_SHIP_NAMES],
  ["Portuguese", PORTUGUESE_SHIP_NAMES],
];

describe("ship name generators", () => {
  it("provides exactly the five requested nationalities, each populated", () => {
    expect(POOLS.map(([n]) => n)).toEqual(["English", "French", "Spanish", "Dutch", "Portuguese"]);
    for (const [, pool] of POOLS) {
      expect(pool.length).toBeGreaterThan(0);
      // No blank or duplicate names within a pool.
      expect(new Set(pool).size).toBe(pool.length);
      expect(pool.every((n) => n.trim().length > 0)).toBe(true);
    }
  });

  it("generates a name drawn from the requested pool", () => {
    const rng = new Rng(7);
    for (const [, pool] of POOLS) {
      for (let i = 0; i < 50; i++) {
        expect(pool).toContain(randomShipName(rng, pool));
      }
    }
  });

  it("covers the whole pool given enough draws (uniform-ish over the pool)", () => {
    const rng = new Rng(3);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(randomShipName(rng, ENGLISH_SHIP_NAMES));
    expect(seen.size).toBe(ENGLISH_SHIP_NAMES.length);
  });
});
