/**
 * Terminal/route/transport types and the compatibility rules between them --
 * shared by the simulation engine (src/sim/location.ts, routes.ts,
 * companyHome.ts) and the editor (types.ts, companyHome.ts, autoRoutes.ts).
 */

export type TerminalType =
  | "Port" | "Wagon yard" | "Airport" | "Platform" | "Spaceport" | "TransitDepot" | "Station" | "Market";

export const TERMINAL_TYPES: TerminalType[] = [
  "Port", "Wagon yard", "Airport", "Platform", "Spaceport", "TransitDepot", "Station", "Market",
];

export type RouteType = "Land" | "Air" | "Sea" | "Space" | "Road" | "Railroad" | "Trail";

export const ROUTE_TYPES: RouteType[] = ["Land", "Air", "Sea", "Space", "Road", "Railroad", "Trail"];

/** Which TerminalTypes each RouteType requires at both ends -- Space connects Spaceports, Road connects TransitDepots, Railroad connects Stations, Sea connects Ports OR Platforms, Trail connects Markets (native villages). */
export const ROUTE_TERMINAL_COMPATIBILITY: Record<RouteType, TerminalType[]> = {
  Land: ["Wagon yard"],
  Air: ["Airport"],
  Sea: ["Port", "Platform"],
  // A Space route can only connect Spaceports.
  Space: ["Spaceport"],
  // A Road route can only connect TransitDepots.
  Road: ["TransitDepot"],
  // A Railroad route can only connect Stations.
  Railroad: ["Station"],
  // A Trail route (foot/porter travel) can only connect Markets.
  Trail: ["Market"],
};

/** Every RouteType a Route between Locations with these two TerminalType sets could plausibly be, in ROUTE_TYPES priority order. */
export function compatibleRouteTypes(a: readonly TerminalType[], b: readonly TerminalType[]): RouteType[] {
  return ROUTE_TYPES.filter((routeType) => {
    const required = ROUTE_TERMINAL_COMPATIBILITY[routeType];
    return required.some((t) => a.includes(t)) && required.some((t) => b.includes(t));
  });
}

/** Mirrors each src/sim/transport.ts subclass's allowedRouteTypes() override -- used where a Transport is represented as a plain type tag rather than a real class instance (the editor's authored fleets). */
export type TransportType = "Ship" | "WagonTrain" | "Plane" | "Spaceship" | "Lorry" | "FreightTrain" | "PorterParty";

export const TRANSPORT_TYPES: TransportType[] = [
  "Ship", "WagonTrain", "Plane", "Spaceship", "Lorry", "FreightTrain", "PorterParty",
];

export const TRANSPORT_TYPE_LABELS: Record<TransportType, string> = {
  Ship: "Ship",
  WagonTrain: "Wagon Train",
  Plane: "Plane",
  Spaceship: "Spaceship",
  Lorry: "Lorry",
  FreightTrain: "Freight Train",
  PorterParty: "Porter Party",
};

export const TRANSPORT_TYPE_ROUTE_TYPES: Record<TransportType, RouteType[]> = {
  Ship: ["Sea"],
  WagonTrain: ["Land"],
  Plane: ["Air"],
  Spaceship: ["Space"],
  Lorry: ["Road"],
  FreightTrain: ["Railroad"],
  PorterParty: ["Trail"],
};

/** Whether a TerminalType set has at least one TerminalType compatible with every one of `transportType`'s allowed RouteTypes. */
export function terminalTypesSupportTransportType(
  terminalTypes: readonly TerminalType[],
  transportType: TransportType,
): boolean {
  return TRANSPORT_TYPE_ROUTE_TYPES[transportType].every((routeType) =>
    ROUTE_TERMINAL_COMPATIBILITY[routeType].some((t) => terminalTypes.includes(t)),
  );
}
