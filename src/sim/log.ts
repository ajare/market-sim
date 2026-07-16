/**
 * Shared narrative-log entry shape -- one day's clause-assembled text entry,
 * used by both Captain's Ship's Log (see Captain.recordShipLog in captain.ts)
 * and Explorer's own log (see explorer.ts). Split out from captain.ts so
 * Explorer can reuse the same shape without a captain.ts<->explorer.ts
 * dependency.
 */
export interface ShipLogEntry {
  day: number;
  text: string;
}
