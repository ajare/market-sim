import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_RETENTION_DAYS, getHistoryRetentionDays, setHistoryRetentionDays, trimHistory,
} from "../historyRetention";
import { buildWorld } from "../buildWorld";
import { Company } from "../faction";

describe("historyRetention", () => {
  afterEach(() => {
    // Every test here mutates the module-level setting -- restore the
    // default so it doesn't leak into other test files.
    setHistoryRetentionDays(DEFAULT_HISTORY_RETENTION_DAYS);
  });

  it("defaults to 30 days", () => {
    expect(getHistoryRetentionDays()).toBe(30);
    expect(DEFAULT_HISTORY_RETENTION_DAYS).toBe(30);
  });

  it("setHistoryRetentionDays changes the global window read back by getHistoryRetentionDays", () => {
    setHistoryRetentionDays(10);
    expect(getHistoryRetentionDays()).toBe(10);
  });

  it("clamps to a minimum of 1 day (floors, rejects <= 0)", () => {
    setHistoryRetentionDays(0.4);
    expect(getHistoryRetentionDays()).toBe(1);
    setHistoryRetentionDays(-5);
    expect(getHistoryRetentionDays()).toBe(1);
  });

  it("drops entries older than the trailing window, keeping the rest, given entries 1..40 and currentDay 40 with the default 30-day window", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ day: i + 1 }));
    trimHistory(entries, 40);
    // Window is [40 - 30 + 1, 40] = [11, 40] -- 30 entries.
    expect(entries).toHaveLength(30);
    expect(entries[0].day).toBe(11);
    expect(entries[entries.length - 1].day).toBe(40);
  });

  it("is a no-op when every entry is already within the window", () => {
    const entries = [{ day: 5 }, { day: 6 }, { day: 7 }];
    trimHistory(entries, 7);
    expect(entries).toEqual([{ day: 5 }, { day: 6 }, { day: 7 }]);
  });

  it("respects a narrower window set via setHistoryRetentionDays", () => {
    setHistoryRetentionDays(2);
    const entries = [{ day: 1 }, { day: 2 }, { day: 3 }];
    trimHistory(entries, 3);
    // Window is [3 - 2 + 1, 3] = [2, 3].
    expect(entries).toEqual([{ day: 2 }, { day: 3 }]);
  });
});

describe("historyRetention -- integrated with a running World", () => {
  it("keeps Market.history, World.combinedHistory, Captain.tradeLog/portfolioHistory, and Faction.netWorthHistory bounded to the retention window after running well past it", () => {
    setHistoryRetentionDays(5);
    const { world, factions } = buildWorld(3000, { autoMinStockpileDaysFromRoutes: true });

    const days = 20;
    for (let i = 0; i < days; i++) world.step();

    for (const market of [...world.buyMarkets.values(), ...world.sellMarkets.values()]) {
      expect(market.history.length).toBeLessThanOrEqual(5);
    }
    expect(world.combinedHistory.length).toBeLessThanOrEqual(5 * [...world.buyMarkets.values(), ...world.sellMarkets.values()].length);
    for (const captain of world.captains) {
      expect(captain.portfolioHistory.length).toBeLessThanOrEqual(5);
    }
    for (const faction of factions) {
      if (faction instanceof Company) expect(faction.netWorthHistory.length).toBeLessThanOrEqual(5);
    }
  });
});
