import { useEffect, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { LOCATION_COORDINATES, FUEL_DEPOT_NAMES, travelDaysBetween } from "../sim/worldData";
import { ROUTES, getRoute, routeTravelDays, type Point, type Route, type RouteType } from "../sim/routes";
import { Ship, WagonTrain, Plane, type Transport } from "../sim/transport";
import type { Captain } from "../sim/captain";
import { PirateBrigade, PoliceFleet, SoloTrader, Company } from "../sim/faction";
import type { Location, TerminalType } from "../sim/location";
import type { PoliticalEntity } from "../sim/politicalEntity";
import type { MarketEvent } from "../sim/events";
import type { World } from "../sim/world";
import { findShortestPath, pathNodeSequence } from "../sim/pathfinding";

/**
 * Every node a Captain's current voyage still passes through, from where it
 * is right now to its ultimate destination -- recomputed fresh via
 * findShortestPath rather than read off `Captain.path`, since that field
 * only advances leg-by-leg for cargo-carrying trips (see Captain.arrive) and
 * is left stale during a reposition, where the whole multi-hop trip is
 * modeled as one continuous transit with no per-leg bookkeeping at all (see
 * Captain.departEmptyTo). Empty for a Captain not actively routed.
 */
function captainRouteNodes(captain: Captain): string[] {
  if (captain.transport === null || captain.destination === null) return [];
  const finalDestination = captain.cargo !== null ? captain.cargo.destination : captain.destination;
  if (finalDestination === captain.location) return [];
  const path = findShortestPath(captain.location, finalDestination, (r) => captain.transport!.canUseRoute(r));
  if (path === null) return [captain.location, finalDestination];
  return pathNodeSequence(captain.location, path);
}

/** Number of distinct hues in the --political-entity-N categorical palette (index.css) -- PoliticalEntity colors cycle through these by index if there are more political entities than slots. */
const POLITICAL_ENTITY_PALETTE_SIZE = 8;

const ROUTE_COLORS: Record<RouteType, string> = {
  Sea: "#3b82f6",
  Land: "#b45309",
  Air: "#10b981",
};

/** Ship markers are colored by the operating Faction, not transport kind. */
const FACTION_COLORS = {
  pirate: "#ef4444",
  police: "#22c55e",
  company: "#3b82f6",
  soloTrader: "#eab308",
};

/**
 * A ship's marker color signals who's operating it: pirates red, police
 * green, company (pooled-cash fleets) blue, solo traders yellow. SoloTrader is
 * checked before Company since it's a Company subclass.
 */
function factionColor(captain: Captain, fallback: string): string {
  const company = captain.company;
  if (company instanceof PirateBrigade) return FACTION_COLORS.pirate;
  if (company instanceof PoliceFleet) return FACTION_COLORS.police;
  if (company instanceof SoloTrader) return FACTION_COLORS.soloTrader;
  if (company instanceof Company) return FACTION_COLORS.company;
  return fallback;
}

function transportKind(transport: Transport): string {
  if (transport instanceof Ship) return "Ship";
  if (transport instanceof WagonTrain) return "Train";
  if (transport instanceof Plane) return "Plane";
  return "Transport";
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/** Anchor -- Port (and Platform, the other Sea-compatible terminal). Ring, shaft, crossbar, and two hook curls. */
function drawAnchor(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.arc(x, y - r * 0.75, r * 0.28, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.47);
  ctx.lineTo(x, y + r * 0.8);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x - r * 0.5, y - r * 0.05);
  ctx.lineTo(x + r * 0.5, y - r * 0.05);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x - r * 0.45, y + r * 0.5, r * 0.4, -Math.PI * 0.15, Math.PI * 0.65);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + r * 0.45, y + r * 0.5, r * 0.4, Math.PI * 0.35, Math.PI * 1.15, true);
  ctx.stroke();
}

/** Barrel -- Fuel depot. A filled rounded rectangle with two horizontal bands. */
function drawBarrel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const w = r * 1.1;
  const h = r * 1.7;
  const left = x - w / 2;
  const top = y - h / 2;

  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(left, top, w, h, w * 0.3);
  } else {
    ctx.rect(left, top, w, h);
  }
  ctx.fillStyle = color;
  ctx.fill();

  ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top + h * 0.34);
  ctx.lineTo(left + w, top + h * 0.34);
  ctx.moveTo(left, top + h * 0.67);
  ctx.lineTo(left + w, top + h * 0.67);
  ctx.stroke();
}

/** Wheel -- Wagon yard. A rim circle with six spokes and a small hub. */
function drawWheel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const rim = r * 0.85;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;

  ctx.beginPath();
  ctx.arc(x, y, rim, 0, Math.PI * 2);
  ctx.stroke();

  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * rim, y + Math.sin(angle) * rim);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(x, y, r * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Plane -- Airport. A filled dart/paper-airplane silhouette pointing north. */
function drawPlane(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.15, y - r * 0.2);
  ctx.lineTo(x + r * 0.9, y + r * 0.15);
  ctx.lineTo(x + r * 0.15, y + r * 0.05);
  ctx.lineTo(x + r * 0.25, y + r * 0.75);
  ctx.lineTo(x, y + r * 0.5);
  ctx.lineTo(x - r * 0.25, y + r * 0.75);
  ctx.lineTo(x - r * 0.15, y + r * 0.05);
  ctx.lineTo(x - r * 0.9, y + r * 0.15);
  ctx.lineTo(x - r * 0.15, y - r * 0.2);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws the icon for whichever terminal facility best represents this
 * Location, in priority order: fuel depots (their own category, tracked by
 * name rather than TerminalType) get a barrel; otherwise Airport (plane)
 * beats Wagon yard (wheel) beats Port/Platform (anchor, the two
 * Sea-compatible terminal types) -- picked so the rarer, more specific
 * terminal wins over the near-universal Port when a Location has more than
 * one (every non-depot Location has Port plus 0-2 others; only Platform is
 * mutually exclusive with every other type).
 */
function drawLocationIcon(
  ctx: CanvasRenderingContext2D,
  loc: { terminalTypes: ReadonlySet<TerminalType> },
  isDepot: boolean,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  if (isDepot) drawBarrel(ctx, x, y, r, color);
  else if (loc.terminalTypes.has("Airport")) drawPlane(ctx, x, y, r, color);
  else if (loc.terminalTypes.has("Wagon yard")) drawWheel(ctx, x, y, r, color);
  else drawAnchor(ctx, x, y, r, color);
}

interface Marker {
  captain: Captain;
  x: number;
  y: number;
  r: number;
}

interface LocationMarker {
  location: Location;
  x: number;
  y: number;
  r: number;
}

interface CaptainHoverState {
  kind: "captain";
  captain: Captain;
  x: number;
  y: number;
}

interface LocationHoverState {
  kind: "location";
  location: Location;
  atLocation: number;
  inTransit: number;
  events: MarketEvent[];
  x: number;
  y: number;
}

type HoverState = CaptainHoverState | LocationHoverState;

/** Every currently active MarketEvent touching any commodity market at `location`, deduped by name+daysRemaining -- a broad (Global/Location/Worldwide) event is applied as a separate MarketEvent instance to each affected market, so the same logical event otherwise shows up once per commodity/side. */
function locationActiveEvents(world: World, location: string): MarketEvent[] {
  const seen = new Set<string>();
  const events: MarketEvent[] = [];
  for (const market of [...world.buyMarkets.values(), ...world.sellMarkets.values()]) {
    if (market.locationName !== location) continue;
    for (const event of market.activeEvents) {
      const key = `${event.name}|${event.daysRemaining}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events;
}

export function NetworkView() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const politicalEntities = useSimStore((s) => s.politicalEntities);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null || world === null) return;
    const locations = world.locations;

    const politicalEntityIndex = new Map<PoliticalEntity, number>();
    politicalEntities.forEach((politicalEntity, i) => politicalEntityIndex.set(politicalEntity, i));

    const captainsByLocation = new Map<string, Captain[]>();
    for (const captain of world.captains) {
      if (captain.transport === null) continue;
      const list = captainsByLocation.get(captain.location);
      if (list === undefined) captainsByLocation.set(captain.location, [captain]);
      else list.push(captain);
    }

    let markers: Marker[] = [];
    let locationMarkers: LocationMarker[] = [];
    let highlightedCaptain: Captain | null = null;

    function draw(): void {
      const dpr = window.devicePixelRatio || 1;
      const width = container!.clientWidth;
      const height = 520;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const coordEntries = Object.values(LOCATION_COORDINATES);
      if (coordEntries.length === 0) return;
      const xs = coordEntries.map(([x]) => x);
      const ys = coordEntries.map(([, y]) => y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = 52;
      const scaleX = (width - pad * 2) / (maxX - minX || 1);
      const scaleY = (height - pad * 2) / (maxY - minY || 1);
      const projectPoint = (point: Point): [number, number] => {
        const [x, y] = point;
        return [pad + (x - minX) * scaleX, pad + (y - minY) * scaleY];
      };
      const project = (name: string): [number, number] => projectPoint(LOCATION_COORDINATES[name]);

      const border = cssVar("--border", "#999999");
      const textColor = cssVar("--muted", "#666666");
      const accent = cssVar("--accent", "#7c3aed");
      const muted = cssVar("--muted", "#9a97a3");

      /** A Location's icon is colored by whichever PoliticalEntity owns it (cycling through the palette by PoliticalEntity index), falling back to `accent` for a Location with no PoliticalEntity. */
      function colorForLocation(politicalEntity: PoliticalEntity | null): string {
        if (politicalEntity === null) return accent;
        const idx = politicalEntityIndex.get(politicalEntity) ?? 0;
        return cssVar(`--political-entity-${(idx % POLITICAL_ENTITY_PALETTE_SIZE) + 1}`, accent);
      }

      /** Traces a Route's cached curve sample points onto the current path, in the direction from `fromNode` (its `curvePoints()` run origin-to-destination, so a leg being walked in reverse needs them flipped). */
      function traceCurve(route: Route, fromNode: string, started: boolean): boolean {
        const pts = route.origin === fromNode ? route.curvePoints() : [...route.curvePoints()].reverse();
        for (const pt of pts) {
          const [x, y] = projectPoint(pt);
          if (!started) {
            ctx!.moveTo(x, y);
            started = true;
          } else {
            ctx!.lineTo(x, y);
          }
        }
        return started;
      }

      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.55;
      for (const route of ROUTES.values()) {
        ctx.strokeStyle = ROUTE_COLORS[route.routeType];
        ctx.beginPath();
        traceCurve(route, route.origin, false);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // The hovered Captain's full remaining route (current leg plus any
      // further queued legs -- see captainRouteNodes), drawn over the base
      // route network in a thick highlight color, following each leg's
      // actual curve, with intermediate stops ringed so a multi-hop
      // voyage's waypoints are legible.
      if (highlightedCaptain !== null) {
        const nodes = captainRouteNodes(highlightedCaptain);
        if (nodes.length >= 2) {
          const highlight = cssVar("--warning", "#f59e0b");
          ctx.strokeStyle = highlight;
          ctx.lineWidth = 3;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < nodes.length - 1; i++) {
            const legRoute = getRoute(nodes[i], nodes[i + 1]);
            if (legRoute !== undefined) {
              started = traceCurve(legRoute, nodes[i], started);
            } else {
              const [x, y] = project(nodes[i]);
              const [nx, ny] = project(nodes[i + 1]);
              if (!started) {
                ctx.moveTo(x, y);
                started = true;
              }
              ctx.lineTo(nx, ny);
            }
          }
          ctx.stroke();

          const surface = cssVar("--panel-bg", "#ffffff");
          for (let i = 1; i < nodes.length - 1; i++) {
            const [nx, ny] = project(nodes[i]);
            ctx.beginPath();
            ctx.arc(nx, ny, 5, 0, Math.PI * 2);
            ctx.fillStyle = surface;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = highlight;
            ctx.stroke();
          }
        }
      }

      locationMarkers = [];
      for (const loc of locations) {
        const [x, y] = project(loc.name);
        const isDepot = FUEL_DEPOT_NAMES.includes(loc.name);
        drawLocationIcon(ctx, loc, isDepot, x, y, 14, colorForLocation(loc.politicalEntity));
        locationMarkers.push({ location: loc, x, y, r: 14 });
      }

      // Transports -- colored by operating Faction (see factionColor).
      // Docked ships (status AtLocation) stack in a grid above the location
      // they're at; ships in transit are placed on their route line below.
      const markerRadius = 4;
      const cellSize = 11;
      const gridCols = 4;
      const gridGap = 20;

      /** Draws one ship marker at (mx, my) -- shared by the docked grid and the in-transit route placement below. Docked ships get a halo ring; in-transit ones don't (their position on the route line already conveys that). */
      function drawShipMarker(captain: Captain, mx: number, my: number, docked: boolean): void {
        ctx!.beginPath();
        ctx!.arc(mx, my, markerRadius, 0, Math.PI * 2);
        ctx!.fillStyle = factionColor(captain, muted);
        ctx!.fill();
        ctx!.strokeStyle = border;
        ctx!.lineWidth = 0.75;
        ctx!.stroke();

        if (docked) {
          ctx!.beginPath();
          ctx!.arc(mx, my, markerRadius + 1.6, 0, Math.PI * 2);
          ctx!.strokeStyle = textColor;
          ctx!.lineWidth = 1;
          ctx!.stroke();
        }

        markers.push({ captain, x: mx, y: my, r: markerRadius });
      }

      markers = [];

      // Docked ships: stacked in a grid directly above the location they're
      // currently at.
      for (const loc of locations) {
        const captainsHere = (captainsByLocation.get(loc.name) ?? []).filter((c) => c.status === "AtLocation");
        if (captainsHere.length === 0) continue;
        const [cx, cy] = project(loc.name);
        const n = captainsHere.length;
        const cols = Math.min(gridCols, n);
        const bottomRowY = cy - gridGap;
        captainsHere.forEach((captain, i) => {
          const row = Math.floor(i / cols);
          const itemsInRow = Math.min(cols, n - row * cols);
          const col = i % cols;
          const rowWidth = (itemsInRow - 1) * cellSize;
          const mx = cx - rowWidth / 2 + col * cellSize;
          const my = bottomRowY - row * cellSize;
          drawShipMarker(captain, mx, my, true);
        });
      }

      // In-transit ships: placed on their route's actual Bezier curve, at
      // the fraction of the leg's (curve-length) distance they've completed
      // so far -- computed by comparing the leg's total travel time
      // (recomputed fresh via routeTravelDays from the same Route
      // Captain.departXxx used, since a Route's distance is cached and never
      // changes mid-leg) against daysRemaining, which ticks down toward 0 as
      // Captain.act() advances the voyage day by day. A reposition leg
      // spanning more than one Route edge (see captainRouteNodes' comment)
      // has no single curve to follow, so it falls back to a straight-line
      // fraction between its two endpoints, same as before. Ships sharing
      // the same route line are spread out with a small perpendicular
      // offset so they don't stack exactly on top of each other.
      const inTransitGroups = new Map<string, Captain[]>();
      for (const captain of world!.captains) {
        if (captain.transport === null || captain.status !== "InTransit" || captain.destination === null) continue;
        const key = [captain.location, captain.destination].sort().join("||");
        const list = inTransitGroups.get(key);
        if (list === undefined) inTransitGroups.set(key, [captain]);
        else list.push(captain);
      }
      const shipSpacing = 6;
      for (const group of inTransitGroups.values()) {
        const [ox, oy] = project(group[0].location);
        const [dx, dy] = project(group[0].destination!);
        const lineDx = dx - ox;
        const lineDy = dy - oy;
        const lineLen = Math.hypot(lineDx, lineDy) || 1;
        const perpX = -lineDy / lineLen;
        const perpY = lineDx / lineLen;
        const n = group.length;
        group.forEach((captain, i) => {
          const legRoute = getRoute(captain.location, captain.destination!);
          const totalDays = legRoute !== undefined
            ? routeTravelDays(legRoute, captain.transport!.speedUnitsPerDay)
            : travelDaysBetween(captain.location, captain.destination!, captain.transport!.speedUnitsPerDay);
          const fraction = totalDays > 0 ? Math.min(1, Math.max(0, (totalDays - captain.daysRemaining) / totalDays)) : 0;

          let baseX: number;
          let baseY: number;
          if (legRoute !== undefined) {
            const curveFraction = legRoute.origin === captain.location ? fraction : 1 - fraction;
            [baseX, baseY] = projectPoint(legRoute.pointAtFraction(curveFraction));
          } else {
            const [cox, coy] = project(captain.location);
            const [cdx, cdy] = project(captain.destination!);
            baseX = cox + (cdx - cox) * fraction;
            baseY = coy + (cdy - coy) * fraction;
          }
          const offset = (i - (n - 1) / 2) * shipSpacing;
          drawShipMarker(captain, baseX + perpX * offset, baseY + perpY * offset, false);
        });
      }

      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "center";
      for (const loc of locations) {
        const [x, y] = project(loc.name);
        ctx.fillStyle = textColor;
        ctx.fillText(loc.name, x, y + 20);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
    }

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(container);

    let hoveredKey: Captain | Location | null = null;
    function handleMouseMove(e: MouseEvent): void {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const shipHit = markers.find((m) => Math.hypot(m.x - mx, m.y - my) <= m.r + 3);
      if (shipHit !== undefined) {
        if (hoveredKey === shipHit.captain) return;
        hoveredKey = shipHit.captain;
        highlightedCaptain = shipHit.captain;
        draw();
        setHover({ kind: "captain", captain: shipHit.captain, x: shipHit.x, y: shipHit.y });
        return;
      }

      const locationHit = locationMarkers.find((m) => Math.hypot(m.x - mx, m.y - my) <= m.r + 3);
      if (locationHit !== undefined) {
        if (hoveredKey === locationHit.location) return;
        hoveredKey = locationHit.location;
        if (highlightedCaptain !== null) {
          highlightedCaptain = null;
          draw();
        }
        const captainsHere = captainsByLocation.get(locationHit.location.name) ?? [];
        setHover({
          kind: "location",
          location: locationHit.location,
          atLocation: captainsHere.filter((c) => c.status === "AtLocation").length,
          inTransit: captainsHere.filter((c) => c.status === "InTransit").length,
          events: locationActiveEvents(world, locationHit.location.name),
          x: locationHit.x,
          y: locationHit.y,
        });
        return;
      }

      if (hoveredKey === null) return;
      hoveredKey = null;
      if (highlightedCaptain !== null) {
        highlightedCaptain = null;
        draw();
      }
      setHover(null);
    }
    function handleMouseLeave(): void {
      hoveredKey = null;
      if (highlightedCaptain !== null) {
        highlightedCaptain = null;
        draw();
      }
      setHover(null);
    }
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [world, version, politicalEntities]);

  if (world === null) return null;

  return (
    <div className="panel network-panel">
      <h2>Network</h2>
      <div className="network-legend">
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Sea }} />Sea route</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Land }} />Land route</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Air }} />Air route</span>
        <span>
          Anchor = Port · Barrel = Fuel depot · Wheel = Wagon yard · Plane = Airport (icon color = Political Entity)
        </span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.pirate }} />Pirates</span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.police }} />Police</span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.company }} />Company</span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.soloTrader }} />Solo trader</span>
        <span><i className="legend-ring" />Docked (not in transit)</span>
        <span><i className="legend-line" style={{ borderBottomColor: "var(--warning, #f59e0b)" }} />Hover a ship to see its route</span>
      </div>
      <div className="network-canvas-wrap" ref={containerRef}>
        <canvas ref={canvasRef} />
        {hover !== null && hover.kind === "captain" && (
          <div className="network-tooltip" style={{ left: hover.x, top: hover.y }}>
            <div className="network-tooltip-title">{hover.captain.name}</div>
            <div>
              {transportKind(hover.captain.transport!)} — {hover.captain.transport!.name}
            </div>
            <div>{hover.captain.company?.name ?? "(independent)"}</div>
            <div>
              {hover.captain.status}
              {hover.captain.status === "InTransit" && hover.captain.destination !== null
                ? ` → ${hover.captain.destination}`
                : ` @ ${hover.captain.location}`}
            </div>
            {hover.captain.cargo !== null && (
              <div>
                Cargo: {hover.captain.cargo.commodity} × {hover.captain.cargo.quantity.toFixed(1)}
              </div>
            )}
            {Number.isFinite(hover.captain.cash) && <div>Cash: ${hover.captain.cash.toFixed(2)}</div>}
            {hover.captain.cargo?.contract != null && (
              <div className="network-tooltip-events">
                📦 Contract: {hover.captain.cargo.contract.quantity.toFixed(1)} {hover.captain.cargo.contract.commodity} →{" "}
                {hover.captain.cargo.contract.location} (fee ${hover.captain.cargo.contract.deliveryFee.toFixed(2)})
              </div>
            )}
            {hover.captain.activeAgentEvents.length > 0 && (
              <div className="network-tooltip-events">
                {hover.captain.activeAgentEvents.map((event, i) => (
                  <div key={i}>
                    ⚡ {event.message} ({event.daysRemaining}d left)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {hover !== null && hover.kind === "location" && (
          <div className="network-tooltip" style={{ left: hover.x, top: hover.y }}>
            <div className="network-tooltip-title">{hover.location.name}</div>
            <div>
              Status: {world.closedLocations.has(hover.location.name)
                ? `Closed (${world.closedLocations.get(hover.location.name)!.name}, ${world.closedLocations.get(hover.location.name)!.daysRemaining}d left)`
                : "Open"}
            </div>
            <div>Political Entity: {hover.location.politicalEntity?.name ?? "(none)"}</div>
            <div>Transports at location: {hover.atLocation}</div>
            <div>Transports in transit: {hover.inTransit}</div>
            {hover.events.length > 0 && (
              <div className="network-tooltip-events">
                {hover.events.map((event, i) => (
                  <div key={i}>
                    ⚡ {event.message} ({event.daysRemaining}d left)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
