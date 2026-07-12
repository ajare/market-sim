/**
 * A Company's home Location -- the single Location its whole fleet is based
 * out of (see faction.ts's Company). Split out from faction.ts because it
 * needs Location/routes/worldData/PoliticalEntity, none of which faction.ts
 * otherwise pulls in as a group.
 */
import type { Location } from "./location";
import { ROUTE_TERMINAL_COMPATIBILITY } from "./routes";
import type { Transport } from "./transport";
import type { PoliticalEntity } from "./politicalEntity";
import { LOCATIONS } from "./worldData";

/**
 * Whether `location` has at least one TerminalType compatible with every one
 * of `transport`'s allowed RouteTypes -- an OR within a single RouteType's
 * compatible TerminalTypes (e.g. a Ship, needing "Sea", is satisfied by
 * either Port or Platform), an AND across RouteTypes for a (currently
 * hypothetical) Transport allowing more than one. `allowedRouteTypes()`
 * returning null (unrestricted) always passes.
 */
export function locationSupportsTransport(location: Location, transport: Transport): boolean {
  const routeTypes = transport.allowedRouteTypes();
  if (routeTypes === null) return true;
  return routeTypes.every((routeType) =>
    ROUTE_TERMINAL_COMPATIBILITY[routeType].some((terminal) => location.terminalTypes.has(terminal)),
  );
}

/** Whether `location` supports every Transport in `transports` -- see locationSupportsTransport. */
export function locationSupportsFleet(location: Location, transports: readonly Transport[]): boolean {
  return transports.every((transport) => locationSupportsTransport(location, transport));
}

/**
 * The default home Location for a Company: the alphabetically-first Location
 * that supports every Transport in `transports`, searched among
 * `politicalEntity`'s own Locations if it's affiliated with one that actually
 * owns at least one Location, or every Location in the world (LOCATIONS)
 * otherwise -- an Independent Company, or one affiliated with an entity that
 * (not yet, or no longer) owns any Location, is treated the same way. Throws
 * if no candidate qualifies -- e.g. no Location exists yet at all, or none of
 * the candidates support the fleet's TerminalType needs -- which is what
 * makes "a Company can't be created until there's a Location" a natural
 * consequence rather than a special-cased check.
 */
export function defaultCompanyHomeLocation(
  politicalEntity: PoliticalEntity | null,
  transports: readonly Transport[],
): string {
  const scoped = politicalEntity !== null && politicalEntity.locations.length > 0;
  const candidates = scoped ? politicalEntity!.locations : LOCATIONS;
  const supported = candidates.filter((loc) => locationSupportsFleet(loc, transports));
  if (supported.length === 0) {
    throw new Error(
      scoped
        ? `defaultCompanyHomeLocation: no Location belonging to '${politicalEntity!.name}' supports this Company's fleet.`
        : "defaultCompanyHomeLocation: no Location in the world supports this Company's fleet.",
    );
  }
  supported.sort((a, b) => a.name.localeCompare(b.name));
  return supported[0].name;
}
