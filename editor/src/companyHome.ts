/**
 * A Company's home Location for the editor -- mirrors src/sim/companyHome.ts
 * (and src/sim/faction.ts's Company.homeLocation) as a standalone copy, same
 * as nameGenerators.ts/distance.ts: the editor and the sim are separate
 * builds and can't share imports (see CLAUDE.md).
 *
 * Unlike the sim side, nothing here throws when no Location qualifies --
 * the editor tolerates an in-progress/incomplete World (e.g. authoring a
 * Company before any Location exists yet), leaving homeLocationId null until
 * it can be resolved. The sim's Company constructor is the actual hard gate,
 * enforced only once the World is actually built/exported.
 */
import { factionType, type EditorCompany, type EditorLocation, type TransportType } from "./types";
import { terminalTypesSupportTransportType, TRANSPORT_TYPE_ROUTE_TYPES } from "@market-sim/shared/terminal";

export { TRANSPORT_TYPE_ROUTE_TYPES };

/** Whether `location` has at least one TerminalType compatible with `transportType`'s RouteType -- e.g. a Ship (needing "Sea") is satisfied by either Port or Platform. Mirrors src/sim/companyHome.ts's locationSupportsTransport. */
export function locationSupportsTransportType(location: EditorLocation, transportType: TransportType): boolean {
  return terminalTypesSupportTransportType(location.terminalTypes, transportType);
}

/** Whether `location` supports every TransportType in `transportTypes`. */
export function locationSupportsFleet(location: EditorLocation, transportTypes: readonly TransportType[]): boolean {
  return transportTypes.every((t) => locationSupportsTransportType(location, t));
}

/**
 * The default home Location id for a Company: the alphabetically-first
 * Location (by name) supporting every TransportType in `transportTypes`,
 * searched among `politicalEntityId`'s own Locations if it owns at least
 * one, or every Location in the World otherwise (Independent, or affiliated
 * with an entity that doesn't yet own any Location). Returns null if no
 * candidate qualifies (no Location exists yet, or none support the fleet).
 */
export function defaultCompanyHomeLocation(
  politicalEntityId: string | null,
  locations: readonly EditorLocation[],
  transportTypes: readonly TransportType[],
): string | null {
  const owned = politicalEntityId !== null ? locations.filter((l) => l.politicalEntityId === politicalEntityId) : [];
  const candidates = owned.length > 0 ? owned : locations;
  const supported = candidates.filter((l) => locationSupportsFleet(l, transportTypes));
  if (supported.length === 0) return null;
  const sorted = [...supported].sort((a, b) => a.name.localeCompare(b.name));
  return sorted[0].id;
}

/**
 * The home Location id `company` SHOULD have right now: null for a SoloTrader
 * (fleet.length === 1 -- no home port at all), its current homeLocationId if
 * that Location still exists and still supports the fleet, or a freshly
 * computed default otherwise. Used to keep every Company's homeLocationId
 * valid after a Location/PoliticalEntity/fleet edit, without discarding a
 * still-valid manual choice.
 */
export function resolveCompanyHomeLocation(
  company: Pick<EditorCompany, "politicalEntityId" | "homeLocationId" | "fleet">,
  locations: readonly EditorLocation[],
): string | null {
  if (factionType(company.fleet) === "SoloTrader") return null;
  const transportTypes = company.fleet.map((m) => m.transportType);
  const current = company.homeLocationId !== null ? locations.find((l) => l.id === company.homeLocationId) : undefined;
  if (current !== undefined && locationSupportsFleet(current, transportTypes)) return current.id;
  return defaultCompanyHomeLocation(company.politicalEntityId, locations, transportTypes);
}

/** Re-resolves every Company's homeLocationId against the current Locations -- see resolveCompanyHomeLocation. Called after any edit that could invalidate one (a Location/its TerminalTypes/its PoliticalEntity removed or changed). */
export function refreshCompanyHomeLocations(
  companies: readonly EditorCompany[],
  locations: readonly EditorLocation[],
): EditorCompany[] {
  return companies.map((c) => ({ ...c, homeLocationId: resolveCompanyHomeLocation(c, locations) }));
}
