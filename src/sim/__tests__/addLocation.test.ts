import { describe, expect, it } from "vitest";
import { buildWorld } from "../buildWorld";
import { LOCATION_COORDINATES } from "../worldData";
import { getRoutes } from "../routes";
import { findShortestPath } from "../pathfinding";
import { marketKey } from "../markets";
import { Company } from "../faction";

describe("World.addLocation", () => {
  it("adds a uniquely-named, Port-only, produced-only Location, wires it into the route network and markets, and is reachable by pathfinding", () => {
    const { world, politicalEntities } = buildWorld();
    const entity = politicalEntities[0];
    const existingNames = new Set(world.locations.map((l) => l.name));
    const beforeLocationCount = world.locations.length;

    // Placed near the centroid of the existing world so it has plenty of
    // sea-capable neighbors within range.
    const coords = Object.values(LOCATION_COORDINATES);
    const cx = coords.reduce((sum, [x]) => sum + x, 0) / coords.length;
    const cy = coords.reduce((sum, [, y]) => sum + y, 0) / coords.length;

    const location = world.addLocation(cx, cy, entity, 500, 3000);

    expect(world.locations.length).toBe(beforeLocationCount + 1);
    expect(world.locations).toContain(location);
    expect(existingNames.has(location.name)).toBe(false);
    expect([...location.terminalTypes]).toEqual(["Port"]);
    expect(location.consumedCommodities).toEqual({});
    expect(Object.keys(location.producedCommodities).length).toBeGreaterThan(0);
    expect(location.politicalEntity).toBe(entity);
    expect(entity.locations).toContain(location);
    expect(LOCATION_COORDINATES[location.name]).toEqual([cx, cy]);

    // Markets: a buy Market per produced commodity, plus a Fuel buy Market.
    for (const commodity of Object.keys(location.producedCommodities)) {
      expect(world.buyMarkets.has(marketKey(location.name, commodity))).toBe(true);
    }
    expect(world.buyMarkets.has(marketKey(location.name, "Fuel"))).toBe(true);

    // Connected to at least one neighbor by a Sea route (it's at the
    // centroid of a dense default world, well within maxDistance=3000).
    const connectedToAnyNeighbor = world.locations.some(
      (l) => l.name !== location.name && getRoutes(location.name, l.name).some((r) => r.routeType === "Sea"),
    );
    expect(connectedToAnyNeighbor).toBe(true);

    // Pathfinding (the WeakMap adjacency cache) picks up the new Location
    // immediately -- no stale cache miss.
    const otherLocation = world.locations.find((l) => l.name !== location.name)!;
    const path = findShortestPath(otherLocation.name, location.name, () => true);
    expect(path).not.toBeNull();
  });

  it("tops up the fleet across eligible Companies at their OWN home Location, not the new one", () => {
    const { world } = buildWorld();
    const entity = world.locations[0].politicalEntity!;
    const shipsBefore = world.captains.filter((c) => c.transport !== null).length;
    const captainsBefore = new Set(world.captains);

    const coords = Object.values(LOCATION_COORDINATES);
    const cx = coords.reduce((sum, [x]) => sum + x, 0) / coords.length;
    const cy = coords.reduce((sum, [, y]) => sum + y, 0) / coords.length;
    const location = world.addLocation(cx, cy, entity, 500, 3000);

    const shipsAfter = world.captains.filter((c) => c.transport !== null).length;
    expect(shipsAfter).toBeGreaterThan(shipsBefore);

    const newCaptains = world.captains.filter((c) => !captainsBefore.has(c));
    expect(newCaptains.length).toBeGreaterThan(0);
    for (const captain of newCaptains) {
      expect(captain.company).toBeInstanceOf(Company);
      const company = captain.company as Company;
      // Every new ship starts at its OWN Company's home Location, never the
      // brand-new one (per the grilled spec).
      expect(company.homeLocation).not.toBeNull();
      expect(captain.locationName).toBe(company.homeLocation);
      expect(captain.locationName).not.toBe(location.name);
    }
  });

  it("removes an existing Sea route that now sits too close to the new port (detour rule)", () => {
    const { world, politicalEntities } = buildWorld();
    const entity = politicalEntities[0];

    // Find an existing Sea route with real length, then place the new port
    // exactly at its midpoint -- guaranteed to sit "along the way" (distance
    // 0 from the segment), so any positive detourDistance blocks it.
    let originName = "";
    let destName = "";
    let midX = 0;
    let midY = 0;
    const names = world.locations.map((l) => l.name);
    outer: for (const a of names) {
      for (const b of names) {
        const route = getRoutes(a, b).find((r) => r.routeType === "Sea");
        if (route !== undefined && route.distance > 100) {
          const [ox, oy] = LOCATION_COORDINATES[route.origin];
          const [dx, dy] = LOCATION_COORDINATES[route.destination];
          originName = route.origin;
          destName = route.destination;
          midX = (ox + dx) / 2;
          midY = (oy + dy) / 2;
          break outer;
        }
      }
    }
    expect(originName).not.toBe("");

    const wasConnected = getRoutes(originName, destName).some((r) => r.routeType === "Sea");
    expect(wasConnected).toBe(true);

    world.addLocation(midX, midY, entity, 500, 3000);

    const stillConnected = getRoutes(originName, destName).some((r) => r.routeType === "Sea");
    expect(stillConnected).toBe(false);
  });

  it("is deterministic given the same RNG state is not shared across builds -- at minimum, never throws and never collides names", () => {
    const { world, politicalEntities } = buildWorld();
    const entity = politicalEntities[0];
    const coords = Object.values(LOCATION_COORDINATES);
    const cx = coords.reduce((sum, [x]) => sum + x, 0) / coords.length;
    const cy = coords.reduce((sum, [, y]) => sum + y, 0) / coords.length;

    const names = new Set(world.locations.map((l) => l.name));
    for (let i = 0; i < 5; i++) {
      const loc = world.addLocation(cx + i, cy + i, entity, 500, 3000);
      expect(names.has(loc.name)).toBe(false);
      names.add(loc.name);
    }
  });
});
