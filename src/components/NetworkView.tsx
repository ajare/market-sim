import { useEffect, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { LOCATION_COORDINATES, FUEL_DEPOT_NAMES } from "../sim/worldData";
import { ROUTES, type RouteType } from "../sim/routes";
import { Ship, WagonTrain, Plane, type Transport } from "../sim/transport";
import type { Captain } from "../sim/captain";
import type { TerminalType } from "../sim/location";
import type { Country } from "../sim/country";

/** Number of distinct hues in the --country-N categorical palette (index.css) -- Country colors cycle through these by index if there are more countries than slots. */
const COUNTRY_PALETTE_SIZE = 8;

const ROUTE_COLORS: Record<RouteType, string> = {
  Sea: "#3b82f6",
  Land: "#b45309",
  Air: "#10b981",
};

/** Transport kinds map 1:1 onto the RouteType they're restricted to, so reuse the same palette. */
function transportColor(transport: Transport, fallback: string): string {
  if (transport instanceof Ship) return ROUTE_COLORS.Sea;
  if (transport instanceof WagonTrain) return ROUTE_COLORS.Land;
  if (transport instanceof Plane) return ROUTE_COLORS.Air;
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

interface HoverState {
  captain: Captain;
  x: number;
  y: number;
}

export function NetworkView() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const countries = useSimStore((s) => s.countries);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null || world === null) return;
    const locations = world.locations;

    const countryIndex = new Map<Country, number>();
    countries.forEach((country, i) => countryIndex.set(country, i));

    const captainsByLocation = new Map<string, Captain[]>();
    for (const captain of world.captains) {
      if (captain.transport === null) continue;
      const list = captainsByLocation.get(captain.location);
      if (list === undefined) captainsByLocation.set(captain.location, [captain]);
      else list.push(captain);
    }

    let markers: Marker[] = [];

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
      const project = (name: string): [number, number] => {
        const [x, y] = LOCATION_COORDINATES[name];
        return [pad + (x - minX) * scaleX, pad + (y - minY) * scaleY];
      };

      const border = cssVar("--border", "#999999");
      const textColor = cssVar("--muted", "#666666");
      const accent = cssVar("--accent", "#7c3aed");
      const muted = cssVar("--muted", "#9a97a3");

      /** A Location's icon is colored by whichever Country owns it (cycling through the palette by Country index), falling back to `accent` for a Location with no Country. */
      function colorForLocation(country: Country | null): string {
        if (country === null) return accent;
        const idx = countryIndex.get(country) ?? 0;
        return cssVar(`--country-${(idx % COUNTRY_PALETTE_SIZE) + 1}`, accent);
      }

      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.55;
      for (const route of ROUTES.values()) {
        const [x1, y1] = project(route.origin);
        const [x2, y2] = project(route.destination);
        ctx.strokeStyle = ROUTE_COLORS[route.routeType];
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      for (const loc of locations) {
        const [x, y] = project(loc.name);
        const isDepot = FUEL_DEPOT_NAMES.includes(loc.name);
        drawLocationIcon(ctx, loc, isDepot, x, y, 14, colorForLocation(loc.country));
      }

      // Transports, ringed around the location they're currently at --
      // colored by kind, underlined when actually docked (not in transit).
      // Ring radius is bigger than the (2x-sized) location icon's own
      // footprint so ship markers don't overlap it.
      const ringRadius = 20;
      const markerRadius = 2.75;
      markers = [];
      for (const loc of locations) {
        const captainsHere = captainsByLocation.get(loc.name);
        if (captainsHere === undefined || captainsHere.length === 0) continue;
        const [cx, cy] = project(loc.name);
        const n = captainsHere.length;
        captainsHere.forEach((captain, i) => {
          const angle = (2 * Math.PI * i) / n - Math.PI / 2;
          const mx = cx + ringRadius * Math.cos(angle);
          const my = cy + ringRadius * Math.sin(angle);

          ctx.beginPath();
          ctx.arc(mx, my, markerRadius, 0, Math.PI * 2);
          ctx.fillStyle = transportColor(captain.transport!, muted);
          ctx.fill();
          ctx.strokeStyle = border;
          ctx.lineWidth = 0.75;
          ctx.stroke();

          if (captain.status === "AtLocation") {
            ctx.beginPath();
            ctx.moveTo(mx - markerRadius, my + markerRadius + 1.5);
            ctx.lineTo(mx + markerRadius, my + markerRadius + 1.5);
            ctx.strokeStyle = textColor;
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }

          markers.push({ captain, x: mx, y: my, r: markerRadius });
        });
      }

      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      for (const loc of locations) {
        const [x, y] = project(loc.name);
        ctx.fillStyle = textColor;
        ctx.fillText(loc.name, x + 24, y);
      }
    }

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(container);

    let hoveredCaptain: Captain | null = null;
    function handleMouseMove(e: MouseEvent): void {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = markers.find((m) => Math.hypot(m.x - mx, m.y - my) <= m.r + 3);
      if ((hit?.captain ?? null) === hoveredCaptain) return;
      hoveredCaptain = hit?.captain ?? null;
      setHover(hit === undefined ? null : { captain: hit.captain, x: hit.x, y: hit.y });
    }
    function handleMouseLeave(): void {
      hoveredCaptain = null;
      setHover(null);
    }
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [world, version, countries]);

  if (world === null) return null;

  return (
    <div className="panel network-panel">
      <h2>Network</h2>
      <div className="network-legend">
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Sea }} />Sea route / Ship</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Land }} />Land route / Train</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Air }} />Air route / Plane</span>
        <span>Anchor = Port · Barrel = Fuel depot · Wheel = Wagon yard · Plane = Airport (icon color = Country)</span>
        <span><i className="legend-underline" />Docked (not in transit)</span>
      </div>
      <div className="network-canvas-wrap" ref={containerRef}>
        <canvas ref={canvasRef} />
        {hover !== null && (
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
            <div>Cash: ${hover.captain.cash.toFixed(2)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
