import { useEffect, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { LOCATION_COORDINATES, FUEL_DEPOT_NAMES } from "../sim/worldData";
import { ROUTES, type RouteType } from "../sim/routes";
import { Ship, Train, Plane, type Transport } from "../sim/transport";
import type { Captain } from "../sim/captain";

const ROUTE_COLORS: Record<RouteType, string> = {
  Sea: "#3b82f6",
  Railroad: "#b45309",
  Air: "#10b981",
};

/** Transport kinds map 1:1 onto the RouteType they're restricted to, so reuse the same palette. */
function transportColor(transport: Transport, fallback: string): string {
  if (transport instanceof Ship) return ROUTE_COLORS.Sea;
  if (transport instanceof Train) return ROUTE_COLORS.Railroad;
  if (transport instanceof Plane) return ROUTE_COLORS.Air;
  return fallback;
}

function transportKind(transport: Transport): string {
  if (transport instanceof Ship) return "Ship";
  if (transport instanceof Train) return "Train";
  if (transport instanceof Plane) return "Plane";
  return "Transport";
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null || world === null) return;
    const locations = world.locations;

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

        ctx.beginPath();
        if (isDepot) {
          const r = 5;
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
          ctx.fillStyle = muted;
        } else {
          ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = accent;
        }
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.stroke();
      }

      // Transports, ringed around the location they're currently at --
      // colored by kind, underlined when actually docked (not in transit).
      const ringRadius = 11;
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
        ctx.fillText(loc.name, x + 8, y);
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
  }, [world, version]);

  if (world === null) return null;

  return (
    <div className="panel network-panel">
      <h2>Network</h2>
      <div className="network-legend">
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Sea }} />Sea route / Ship</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Railroad }} />Railroad route / Train</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Air }} />Air route / Plane</span>
        <span><i className="legend-swatch legend-diamond" />Fuel depot</span>
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
