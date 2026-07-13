/**
 * Generic sailor nicknames drawn for a Ship's Sailor crew (see
 * Faction.crewTransport) -- deliberately a single pool, not nationality-
 * specific like names.ts/shipNames.ts, since these read as informal sailor
 * slang rather than culturally-coded names. Sim-only: the editor never
 * models individual crew, so this has no editor counterpart and isn't in
 * @market-sim/shared.
 */
import type { NameRng } from "./names";

export const SAILOR_NICKNAMES: string[] = [
  "Salty", "Bosun", "Rigger", "Sparks", "Barnacle", "Cookie", "Peg-Leg", "Scuttles",
  "Anchor", "Gully", "Hook", "Tanker", "Rope", "Gunner", "Compass", "Lookout",
  "Deckhand", "Splice", "Tar", "Bilge", "Cutlass", "Grog", "Weevil", "Plank",
  "Halyard", "Keel", "Ballast", "Crow's Nest", "Driftwood", "Squall", "Tide",
  "Barnacle Bill", "Old Salt", "Rum Jack", "Sea Dog", "Whistle", "Knot", "Tarpaulin",
];

/**
 * Picks a nickname not already used by `existingNames` (a single Ship's
 * crew -- dedup is scoped per-ship, not per-Faction or world-wide, so the
 * same nickname can recur on different ships). Falls back to a numbered
 * variant (" 2", " 3", ...) of a random pick once the whole pool is
 * exhausted, mirroring Faction.dedupeTransportName's suffixing.
 */
export function randomSailorNickname(rng: NameRng, existingNames: Iterable<string> = []): string {
  const used = new Set(existingNames);
  const available = SAILOR_NICKNAMES.filter((name) => !used.has(name));
  if (available.length > 0) return rng.choice(available);
  let suffix = 2;
  let candidate: string;
  do {
    candidate = `${rng.choice(SAILOR_NICKNAMES)} ${suffix}`;
    suffix += 1;
  } while (used.has(candidate));
  return candidate;
}
