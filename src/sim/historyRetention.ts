/**
 * Global cap on every day-stamped history array in the simulation
 * (Market.history, World.combinedHistory, FleetOwner.netWorthHistory,
 * Captain.tradeLog/portfolioHistory/shipLog): as each one appends a new
 * day's entries, entries older than the trailing HISTORY_RETENTION_DAYS
 * window are dropped, so a long-running session's memory footprint stays
 * bounded instead of growing for the lifetime of the process. Module-level
 * (like worldData.ts's DISPLAY_DISTANCE_UNIT) -- a single global knob every
 * history-owning class reads, rather than a per-World setting.
 */

export const DEFAULT_HISTORY_RETENTION_DAYS = 30;

let HISTORY_RETENTION_DAYS = DEFAULT_HISTORY_RETENTION_DAYS;

export function setHistoryRetentionDays(days: number): void {
  HISTORY_RETENTION_DAYS = Math.max(1, Math.floor(days));
}

export function getHistoryRetentionDays(): number {
  return HISTORY_RETENTION_DAYS;
}

/**
 * Drops entries from the front of `entries` (oldest first) whose `day` falls
 * outside the trailing HISTORY_RETENTION_DAYS window ending at `currentDay`.
 * Mutates in place. Every caller appends strictly in day order, so the
 * array is always day-sorted and the oldest entries are always at the
 * front -- this walks forward only as far as the entries actually being
 * dropped (typically 0 or a handful per call), not the whole array.
 */
export function trimHistory<T extends { day: number }>(entries: T[], currentDay: number): void {
  const cutoff = currentDay - HISTORY_RETENTION_DAYS + 1;
  let dropCount = 0;
  while (dropCount < entries.length && entries[dropCount].day < cutoff) dropCount++;
  if (dropCount > 0) entries.splice(0, dropCount);
}
