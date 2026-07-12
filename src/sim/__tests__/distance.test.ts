import { describe, it, expect } from "vitest";
import { normalizedDistance, toLonLat, centralAngle, type DistanceConfig } from "../distance";
import { buildWorldFromJson } from "../buildWorldFromJson";
import { buildWorld } from "../buildWorld";
import { distanceBetween, getDistanceConfig } from "../worldData";

const FLAT: DistanceConfig = { mode: "flat", radius: 1, lonSpan: 180, worldScale: 100 };
const GLOBE: DistanceConfig = { mode: "globe", radius: 100, lonSpan: 180, worldScale: 100 };

describe("distance module", () => {
  it("flat distance is Euclidean scaled by worldScale", () => {
    // Normalized (0,0.5)->(1,0.5) is a full world width => 1 * worldScale.
    expect(normalizedDistance(0, 0.5, 1, 0.5, FLAT)).toBeCloseTo(100, 6);
    expect(normalizedDistance(0, 0, 1, 1, FLAT)).toBeCloseTo(Math.SQRT2 * 100, 6);
  });

  it("maps normalized position to lon/lat, north-up, centered on 0", () => {
    // lonSpan 180: x 0->1 spans lon -90..+90; y 0(top)->1 spans lat +90..-90.
    expect(toLonLat(0, 0.5, 180)).toEqual([-90, 0]);
    expect(toLonLat(1, 0.5, 180)).toEqual([90, 0]);
    expect(toLonLat(0.5, 0, 180)).toEqual([0, 90]);
    expect(toLonLat(0.5, 1, 180)).toEqual([0, -90]);
  });

  it("clamps latitude/longitude for out-of-canvas positions", () => {
    const [lon, lat] = toLonLat(2, -1, 180);
    expect(lon).toBe(180);
    expect(lat).toBe(90);
  });

  it("central angle: 90 degrees of longitude at the equator is pi/2", () => {
    expect(centralAngle(-45, 0, 45, 0)).toBeCloseTo(Math.PI / 2, 10);
    expect(centralAngle(0, 0, 0, 0)).toBeCloseTo(0, 12);
  });

  it("globe distance is radius * central angle", () => {
    // (0.25,0.5)->(0.75,0.5): lon -45..45 at equator => pi/2 rad => radius*pi/2.
    expect(normalizedDistance(0.25, 0.5, 0.75, 0.5, GLOBE)).toBeCloseTo((100 * Math.PI) / 2, 6);
    // Same two points read very differently under flat vs globe.
    expect(normalizedDistance(0.25, 0.5, 0.75, 0.5, FLAT)).toBeCloseTo(50, 6);
  });
});

/**
 * An editor-shaped World whose first two ports are A(normalized 0.25,0.5) and
 * B(0.75,0.5) -- the pair the distance assertions measure -- padded with filler
 * ports so it clears World's 20-location minimum. `extra` overlays the distance
 * fields (distanceMode/globeRadius/globeLonSpan).
 */
function twoPortWorld(extra: Record<string, unknown>): string {
  const locations: unknown[] = [
    {
      id: "loc-1", name: "A", x: 25, y: 50, politicalEntityId: "pe-1",
      producedCommodities: { Ore: 1 }, consumedCommodities: {},
      stockpiles: { Ore: 300 }, minStockpiles: {}, basePriceModifiers: { Ore: 1 },
      fuelPrice: 1.25, terminalTypes: ["Port"],
    },
    {
      id: "loc-2", name: "B", x: 75, y: 50, politicalEntityId: "pe-1",
      producedCommodities: {}, consumedCommodities: { Ore: 1 },
      stockpiles: { Ore: 30 }, minStockpiles: { Ore: 80 }, basePriceModifiers: { Ore: 1 },
      fuelPrice: 1.25, terminalTypes: ["Port"],
    },
  ];
  for (let i = 3; i <= 22; i++) {
    const produces = i % 2 === 0;
    locations.push({
      id: `loc-${i}`, name: `Port ${i}`, x: 20 + (i % 5) * 12, y: 20 + Math.floor(i / 5) * 15,
      politicalEntityId: "pe-1",
      producedCommodities: produces ? { Ore: 1 } : {}, consumedCommodities: produces ? {} : { Ore: 1 },
      stockpiles: produces ? { Ore: 300 } : { Ore: 30 }, minStockpiles: produces ? {} : { Ore: 80 },
      basePriceModifiers: { Ore: 1 }, fuelPrice: 1.25, terminalTypes: ["Port"],
    });
  }
  return JSON.stringify({
    version: 3,
    worldScale: 100,
    ...extra,
    politicalEntities: [{ id: "pe-1", name: "Realm", type: "Country" }],
    commodities: [{ name: "Ore", basePrice: 20, productionRate: 8, consumptionRate: 8 }],
    locations,
    companies: [],
    routes: [{ id: "route-1", locationAId: "loc-1", locationBId: "loc-2", routeType: "Sea", controlPoints: [] }],
  });
}

describe("distance mode through buildWorldFromJson", () => {
  it("flat world measures the straight world distance", () => {
    buildWorldFromJson(twoPortWorld({ distanceMode: "flat" }));
    // A(25,50)-B(75,50): 50 world units apart.
    expect(distanceBetween("A", "B")).toBeCloseTo(50, 6);
    expect(getDistanceConfig().mode).toBe("flat");
  });

  it("globe world measures the great-circle distance with the given radius", () => {
    buildWorldFromJson(twoPortWorld({ distanceMode: "globe", globeRadius: 100, globeLonSpan: 180 }));
    // Normalized (0.25,0.5)-(0.75,0.5) => pi/2 rad => 100*pi/2.
    expect(distanceBetween("A", "B")).toBeCloseTo((100 * Math.PI) / 2, 4);
    expect(getDistanceConfig().mode).toBe("globe");
  });

  it("a missing distanceMode defaults to flat (older files)", () => {
    buildWorldFromJson(twoPortWorld({}));
    expect(distanceBetween("A", "B")).toBeCloseTo(50, 6);
    expect(getDistanceConfig().mode).toBe("flat");
  });

  it("buildWorld resets a leaked globe config back to flat", () => {
    buildWorldFromJson(twoPortWorld({ distanceMode: "globe", globeRadius: 100, globeLonSpan: 180 }));
    expect(getDistanceConfig().mode).toBe("globe");
    buildWorld();
    const config = getDistanceConfig();
    expect(config.mode).toBe("flat");
    expect(config.worldScale).toBe(1);
  });
});
