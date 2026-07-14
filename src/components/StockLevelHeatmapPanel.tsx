import { useEffect, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import type { Market } from "../sim/markets";

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

/** Blends `from` -> `to` (both #rrggbb) by `t` (0-1). */
function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** How far past its reference (minStockpile) level a stockpile ratio is still worth coloring as "healthy surplus" before the color scale saturates -- see stockCellColor. */
const RATIO_HEALTHY_CEILING = 2.5;

/**
 * stockpile/referenceStockpile ratio -> a diverging color: `danger` (empty,
 * ratio 0) through `neutral` (right at the reference/minStockpile target,
 * ratio 1) to `healthy` (comfortable surplus, ratio >= RATIO_HEALTHY_CEILING).
 * Diverging (not a single low->high blend, unlike a plain count) because
 * "stock level" for a consumed commodity has a meaningful target in the
 * middle, not just more-is-better -- this is what actually reveals stockouts
 * at a glance across wildly different per-commodity stockpile scales.
 */
function stockCellColor(ratio: number, danger: string, neutral: string, healthy: string): string {
  if (!Number.isFinite(ratio)) return neutral;
  if (ratio <= 1) return lerpColor(danger, neutral, Math.max(0, ratio));
  const t = Math.min(1, (ratio - 1) / (RATIO_HEALTHY_CEILING - 1));
  return lerpColor(neutral, healthy, t);
}

interface HoverState {
  x: number;
  y: number;
  day: number;
  location: string;
  commodity: string;
  stockpile: number;
  reference: number;
}

const ROW_HEIGHT = 16;
const CELL_WIDTH = 6;
const LEFT_PAD = 220;
const TOP_PAD = 20;

/**
 * Heat map of stock level for every (Location, consumed Commodity) pair --
 * `world.sellMarkets` is exactly that set (a Location's consumedCommodities
 * are traded on the "sell" side -- see World's constructor), each already
 * recording its own day-by-day stockpile/referenceStockpile history (see
 * Market.simulateDay). One row per pair, one column per simulated day,
 * colored by stockpile/reference: red near empty, neutral right at the
 * minStockpile target, green comfortably above it -- so a stockout (or a
 * commodity nobody's delivering) stands out across the whole World at a
 * glance. Horizontally AND vertically scrollable -- a long run and a large
 * commodity/location roster both grow this well past one screen.
 */
export function StockLevelHeatmapPanel() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || world === null) return;
    // world.sellMarkets is populated once per (Location, consumed Commodity)
    // pair in World's constructor, in `init.locations` order -- already the
    // natural, stable, location-grouped row order this panel wants.
    const rows: Market[] = [...world.sellMarkets.values()];
    const daySet = new Set<number>();
    for (const market of rows) for (const record of market.history) daySet.add(record.day);
    const days = [...daySet].sort((a, b) => a - b);

    const dpr = window.devicePixelRatio || 1;
    const width = LEFT_PAD + Math.max(1, days.length) * CELL_WIDTH + 8;
    const height = TOP_PAD + rows.length * ROW_HEIGHT + 4;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const neutral = cssVar("--panel-bg", "#ffffff");
    const danger = cssVar("--event-closure", "#e34948");
    const healthy = cssVar("--consumed", "#1baf7a");
    const textColor = cssVar("--muted", "#9a97a3");
    const border = cssVar("--border", "#e5e4e7");

    // Row labels.
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    rows.forEach((market, row) => {
      const y = TOP_PAD + row * ROW_HEIGHT + ROW_HEIGHT / 2;
      ctx.fillText(`${market.locationName} — ${market.commodityName}`, LEFT_PAD - 8, y);
    });

    // Cells -- day-indexed lookup built once per row (not once per cell) so a
    // large rows x days grid doesn't re-scan each row's whole history per cell.
    rows.forEach((market, row) => {
      const byDay = new Map(market.history.map((r) => [r.day, r]));
      days.forEach((day, col) => {
        const record = byDay.get(day);
        const ratio = record === undefined || record.referenceStockpile <= 0 ? NaN : record.stockpile / record.referenceStockpile;
        ctx.fillStyle = stockCellColor(ratio, danger, neutral, healthy);
        ctx.fillRect(LEFT_PAD + col * CELL_WIDTH, TOP_PAD + row * ROW_HEIGHT, CELL_WIDTH, ROW_HEIGHT - 1);
      });
    });

    // Day-axis ticks -- spaced out so labels never overlap regardless of how
    // many days have run.
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
      if (col < 0 || col >= days.length || row < 0 || row >= rows.length) {
        setHover(null);
        return;
      }
      const market = rows[row];
      const record = market.history.find((r) => r.day === days[col]);
      if (record === undefined) {
        setHover(null);
        return;
      }
      setHover({
        x: mx,
        y: my,
        day: record.day,
        location: market.locationName,
        commodity: market.commodityName,
        stockpile: record.stockpile,
        reference: record.referenceStockpile,
      });
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

  const hasData = [...world.sellMarkets.values()].some((m) => m.history.length > 0);

  return (
    <div className="panel heatmap-panel">
      <h2>Stock Level per Location / Consumed Commodity</h2>
      {!hasData ? (
        <p className="muted">No data yet -- step the simulation.</p>
      ) : (
        <>
          <div className="network-legend">
            <span>
              <i className="legend-swatch" style={{ background: "var(--event-closure)" }} />
              Empty (stockout risk)
            </span>
            <span>
              <i className="legend-swatch" style={{ background: "var(--panel-bg)", border: "1px solid var(--border)" }} />
              At the minimum-stockpile target
            </span>
            <span>
              <i className="legend-swatch" style={{ background: "var(--consumed)" }} />
              Comfortable surplus
            </span>
            <span>One column per day, one row per Location/Commodity pair -- hover a cell for the exact numbers.</span>
          </div>
          <div className="heatmap-canvas-wrap stock-heatmap-canvas-wrap">
            <canvas ref={canvasRef} />
            {hover !== null && (
              <div className="network-tooltip" style={{ left: hover.x, top: hover.y }}>
                <div className="network-tooltip-title">
                  {hover.location} — {hover.commodity}
                </div>
                <div>Day {hover.day}</div>
                <div>
                  Stockpile: <strong>{hover.stockpile.toFixed(1)}</strong>
                </div>
                <div>
                  Target: <strong>{hover.reference.toFixed(1)}</strong>
                </div>
                <div>
                  {hover.reference > 0 ? `${Math.round((hover.stockpile / hover.reference) * 100)}% of target` : ""}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
