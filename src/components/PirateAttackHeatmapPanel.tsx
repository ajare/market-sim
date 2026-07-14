import { useEffect, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import type { World } from "../sim/world";

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blends `from` -> `to` (both #rrggbb) by `t` (0-1). Used to turn an attack count into a heat color -- see cellColor. */
function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * count -> heat color, blended from `empty` (panel background, count 0) to
 * `hot` (the accent color, at maxCount). A nonzero count is floored at a 15%
 * blend so even a single attack reads as visibly distinct from an empty
 * cell, not just a slightly-off-white sliver.
 */
function cellColor(count: number, maxCount: number, empty: string, hot: string): string {
  if (count <= 0) return empty;
  const t = maxCount > 0 ? 0.15 + 0.85 * (count / maxCount) : 0.15;
  return lerpColor(empty, hot, Math.min(1, t));
}

/**
 * Every pirate ATTACK count by (day, Location), built from the PirateBrigade's
 * own captains' tradeLog -- each attack is logged once, on the attacking
 * pirate's tradeLog, with `action: "ATTACK"` and `location` set to wherever
 * the pirate (and therefore the victim) was standing that day (see
 * PirateBrigade.attack). A world with no pirates, or one that's never landed
 * a hit, yields an empty map.
 */
function buildCounts(world: World): { counts: Map<number, Map<string, number>>; days: number[]; maxCount: number } {
  const counts = new Map<number, Map<string, number>>();
  const daySet = new Set<number>();
  let maxCount = 0;
  const pirateBrigade = world.pirateBrigade;
  if (pirateBrigade === null) return { counts, days: [], maxCount: 0 };
  for (const captain of pirateBrigade.captains) {
    for (const entry of captain.tradeLog) {
      if (entry.action !== "ATTACK") continue;
      daySet.add(entry.day);
      let byLocation = counts.get(entry.day);
      if (byLocation === undefined) {
        byLocation = new Map();
        counts.set(entry.day, byLocation);
      }
      const next = (byLocation.get(entry.location) ?? 0) + 1;
      byLocation.set(entry.location, next);
      if (next > maxCount) maxCount = next;
    }
  }
  return { counts, days: [...daySet].sort((a, b) => a - b), maxCount };
}

interface HoverState {
  x: number;
  y: number;
  day: number;
  location: string;
  count: number;
}

const ROW_HEIGHT = 16;
const CELL_WIDTH = 6;
const LEFT_PAD = 150;
const TOP_PAD = 20;

/**
 * Heat map of how many pirate attacks landed at each Location, one column
 * per simulated day that saw at least one attack anywhere -- darker/more
 * saturated means more attacks happened there that day. Rows are Locations
 * (world.locations' own order, same as every other panel); columns grow one
 * per attack-day as the simulation runs, in a horizontally scrolling canvas
 * since a long run can span hundreds of days.
 */
export function PirateAttackHeatmapPanel() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || world === null) return;
    const locations = world.locations;
    const { counts, days, maxCount } = buildCounts(world);

    const dpr = window.devicePixelRatio || 1;
    const width = LEFT_PAD + Math.max(1, days.length) * CELL_WIDTH + 8;
    const height = TOP_PAD + locations.length * ROW_HEIGHT + 4;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const empty = cssVar("--panel-bg", "#ffffff");
    const hot = cssVar("--accent", "#7c3aed");
    const textColor = cssVar("--muted", "#9a97a3");
    const border = cssVar("--border", "#e5e4e7");

    // Row labels.
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    locations.forEach((loc, row) => {
      const y = TOP_PAD + row * ROW_HEIGHT + ROW_HEIGHT / 2;
      ctx.fillText(loc.name, LEFT_PAD - 8, y);
    });

    // Cells.
    days.forEach((day, col) => {
      const byLocation = counts.get(day);
      locations.forEach((loc, row) => {
        const count = byLocation?.get(loc.name) ?? 0;
        ctx.fillStyle = cellColor(count, maxCount, empty, hot);
        ctx.fillRect(LEFT_PAD + col * CELL_WIDTH, TOP_PAD + row * ROW_HEIGHT, CELL_WIDTH, ROW_HEIGHT - 1);
      });
    });

    // Day-axis ticks -- spaced out so labels never overlap regardless of how
    // many attack-days exist (same "N ticks across the range" approach as
    // StockHistoryPanel's day axis).
    if (days.length > 0) {
      ctx.strokeStyle = border;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const tickCount = Math.min(days.length, Math.max(2, Math.floor((width - LEFT_PAD) / 60)));
      for (let i = 0; i <= tickCount; i++) {
        const idx = Math.round((i / tickCount) * (days.length - 1));
        const x = LEFT_PAD + idx * CELL_WIDTH + CELL_WIDTH / 2;
        ctx.fillStyle = textColor;
        ctx.fillText(`${days[idx]}`, x, TOP_PAD - 4);
        ctx.beginPath();
        ctx.moveTo(x, TOP_PAD);
        ctx.lineTo(x, height - 4);
        ctx.stroke();
      }
    }

    function handleMouseMove(e: MouseEvent): void {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const col = Math.floor((mx - LEFT_PAD) / CELL_WIDTH);
      const row = Math.floor((my - TOP_PAD) / ROW_HEIGHT);
      if (col < 0 || col >= days.length || row < 0 || row >= locations.length) {
        setHover(null);
        return;
      }
      const day = days[col];
      const location = locations[row].name;
      const count = counts.get(day)?.get(location) ?? 0;
      setHover({ x: mx, y: my, day, location, count });
    }
    function handleMouseLeave(): void {
      setHover(null);
    }
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, version]);

  if (world === null) return null;

  const hasAttacks = world.pirateBrigade !== null && world.pirateBrigade.captains.some(
    (c) => c.tradeLog.some((e) => e.action === "ATTACK"),
  );

  return (
    <div className="panel heatmap-panel">
      <h2>Pirate Attacks per Location</h2>
      {!hasAttacks ? (
        <p className="muted">No pirate attacks yet.</p>
      ) : (
        <>
          <div className="network-legend">
            <span>
              <i className="legend-swatch" style={{ background: "var(--panel-bg)", border: "1px solid var(--border)" }} />
              0 attacks
            </span>
            <span>
              <i className="legend-swatch" style={{ background: "var(--accent)" }} />
              Most attacks (darker = more)
            </span>
            <span>One column per day with an attack, one row per Location -- hover a cell for the exact count.</span>
          </div>
          <div className="heatmap-canvas-wrap">
            <canvas ref={canvasRef} />
            {hover !== null && (
              <div className="network-tooltip" style={{ left: hover.x, top: hover.y }}>
                <div className="network-tooltip-title">{hover.location}</div>
                <div>Day {hover.day}</div>
                <div>
                  <strong>{hover.count}</strong> attack{hover.count === 1 ? "" : "s"}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
