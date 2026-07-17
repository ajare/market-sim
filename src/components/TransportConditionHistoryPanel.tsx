import { useEffect, useMemo, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import type { ConditionRecord } from "../sim/transport";

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/** Fixed, literal colors for the two flagged causes -- not theme-reactive (a red/blue marker means the same thing regardless of light/dark mode), matching the plain-hex convention NetworkView's FACTION_COLORS already uses for the same kind of fixed semantic marker. */
const PIRATE_MARKER_COLOR = "#e34948";
const STORM_MARKER_COLOR = "#2a78d6";

interface TransportSeries {
  name: string;
  captainName: string;
  history: ConditionRecord[];
}

interface HoverState {
  x: number;
  day: number;
  nearest: { name: string; condition: number; cause: ConditionRecord["cause"] };
  count: number;
}

/** A day-labeled cause description for the tooltip -- "transit"/"repair" read as plain condition changes, "pirate"/"storm" get called out since those are the two flagged causes. */
function causeLabel(cause: ConditionRecord["cause"]): string | null {
  if (cause === "pirate") return "pirate attack";
  if (cause === "storm") return "storm/cyclone";
  return null;
}

export function TransportConditionHistoryPanel() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [showTable, setShowTable] = useState(false);

  const series: TransportSeries[] = useMemo(
    () =>
      world === null
        ? []
        : world.shipCaptains
            .filter((c) => c.transport !== null)
            .map((c) => ({
              name: c.transport!.name,
              captainName: c.name,
              history: c.transport!.conditionHistory,
            })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `world` is mutated in place; `version` is what actually signals new history.
    [world, version],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    const nonEmpty = series.filter((s) => s.history.length > 0);
    if (nonEmpty.length === 0) {
      const ctx = canvas.getContext("2d");
      if (ctx !== null) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const allDays = [...new Set(nonEmpty.flatMap((s) => s.history.map((r) => r.day)))].sort((a, b) => a - b);

    const padL = 40;
    const padR = 16;
    const padT = 12;
    const padB = 28;
    let width = 0;
    let height = 280;
    let plotW = 0;
    let plotH = 0;
    let minDay = 0;
    let dayRange = 1;

    const px = (day: number) => padL + ((day - minDay) / dayRange) * plotW;
    // condition is always [0,1] -- a fixed scale, unlike net worth's dynamic niceStep range.
    const py = (condition: number) => padT + plotH - Math.min(1, Math.max(0, condition)) * plotH;

    function renderStatic(): void {
      const dpr = window.devicePixelRatio || 1;
      width = container!.clientWidth;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const border = cssVar("--border", "#e5e4e7");
      const muted = cssVar("--muted", "#9a97a3");
      const lineColor = cssVar("--accent", "#7c3aed");

      plotW = width - padL - padR;
      plotH = height - padT - padB;
      minDay = allDays[0];
      const maxDay = allDays[allDays.length - 1];
      dayRange = Math.max(1, maxDay - minDay);

      // Gridlines at 0/0.25/0.5/0.75/1 -- hairline, solid, recessive.
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.fillStyle = muted;
      ctx.font = "11px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (let v = 0; v <= 1.0001; v += 0.25) {
        const y = py(v);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(width - padR, y);
        ctx.stroke();
        ctx.fillText(v.toFixed(2), padL - 8, y);
      }
      const dayTicks = 5;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i <= dayTicks; i++) {
        const day = Math.round(minDay + (dayRange * i) / dayTicks);
        ctx.fillText(`Day ${day}`, px(day), height - padB + 8);
      }

      // One line per Transport, low opacity so overlapping ships read as
      // density (same technique as NetWorthHistoryPanel) rather than a
      // color-matching puzzle -- there's no per-line categorization here,
      // just the one accent hue.
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = lineColor;
      for (const s of nonEmpty) {
        ctx.beginPath();
        s.history.forEach((r, i) => {
          const x = px(r.day);
          const y = py(r.condition);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Pirate-attack (red) / storm-caused (blue) condition drops -- always
      // shown, not just on hover, across every Transport's history at once.
      for (const s of nonEmpty) {
        for (const r of s.history) {
          if (r.cause !== "pirate" && r.cause !== "storm") continue;
          ctx.beginPath();
          ctx.arc(px(r.day), py(r.condition), 3, 0, Math.PI * 2);
          ctx.fillStyle = r.cause === "pirate" ? PIRATE_MARKER_COLOR : STORM_MARKER_COLOR;
          ctx.fill();
        }
      }
    }

    function highlight(name: string): void {
      const s = nonEmpty.find((c) => c.name === name);
      if (s === undefined) return;
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      ctx.strokeStyle = cssVar("--accent", "#7c3aed");
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      s.history.forEach((r, i) => {
        const x = px(r.day);
        const y = py(r.condition);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    function drawCrosshair(mouseX: number, mouseY: number): void {
      renderStatic();
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      const frac = Math.min(1, Math.max(0, (mouseX - padL) / plotW));
      const idx = Math.round(frac * (allDays.length - 1));
      const day = allDays[idx];
      const x = px(day);

      const muted = cssVar("--muted", "#9a97a3");
      const surface = cssVar("--panel-bg", "#ffffff");
      const accent = cssVar("--accent", "#7c3aed");

      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, height - padB);
      ctx.stroke();

      // Every Transport with a reading THIS exact day -- the one nearest the
      // cursor's vertical position gets called out (highlighted + tooltipped).
      const atDay = nonEmpty
        .map((s) => ({ name: s.name, record: s.history.find((r) => r.day === day) }))
        .filter((e): e is { name: string; record: ConditionRecord } => e.record !== undefined);
      if (atDay.length === 0) {
        setHover(null);
        return;
      }

      let nearest = atDay[0];
      let bestDist = Infinity;
      for (const e of atDay) {
        const dist = Math.abs(py(e.record.condition) - mouseY);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = e;
        }
      }

      highlight(nearest.name);

      const y = py(nearest.record.condition);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();

      setHover({
        x,
        day,
        nearest: { name: nearest.name, condition: nearest.record.condition, cause: nearest.record.cause },
        count: atDay.length,
      });
    }

    function handleMouseMove(e: MouseEvent): void {
      const rect = canvas!.getBoundingClientRect();
      drawCrosshair(e.clientX - rect.left, e.clientY - rect.top);
    }
    function handleMouseLeave(): void {
      renderStatic();
      setHover(null);
    }

    renderStatic();
    const resizeObserver = new ResizeObserver(renderStatic);
    resizeObserver.observe(container);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [series, version]);

  if (world === null) return null;

  const anyData = series.some((s) => s.history.length > 0);
  const nonEmpty = series.filter((s) => s.history.length > 0);
  const hasData = nonEmpty.length > 0;
  const tableRows = nonEmpty
    .flatMap((s) => s.history.map((r) => ({ ship: s.name, captain: s.captainName, ...r })))
    .sort((a, b) => b.day - a.day || a.ship.localeCompare(b.ship));

  return (
    <div className="panel chart-panel">
      <h2>Transport condition</h2>
      <div className="chart-filters">
        <button type="button" onClick={() => setShowTable((v) => !v)} disabled={!hasData}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {!anyData ? (
        <p className="muted">No data yet -- step the simulation.</p>
      ) : showTable ? (
        <div className="scroll-table">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Ship</th>
                <th>Captain</th>
                <th>Condition</th>
                <th>Cause</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r, i) => (
                <tr key={i}>
                  <td>{r.day}</td>
                  <td>{r.ship}</td>
                  <td>{r.captain}</td>
                  <td>{r.condition.toFixed(2)}</td>
                  <td>{causeLabel(r.cause) ?? r.cause}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="chart-legend">
            <span>
              <i className="legend-swatch" style={{ background: PIRATE_MARKER_COLOR }} />Pirate attack
            </span>
            <span>
              <i className="legend-swatch" style={{ background: STORM_MARKER_COLOR }} />Storm/cyclone
            </span>
          </div>
          <div className="chart-canvas-wrap" ref={containerRef}>
            <canvas ref={canvasRef} />
            {hover !== null && (
              <div className="network-tooltip chart-tooltip" style={{ left: hover.x }}>
                <div className="network-tooltip-title">Day {hover.day}</div>
                <div>
                  {hover.nearest.name}: <strong>{hover.nearest.condition.toFixed(2)}</strong>
                  {causeLabel(hover.nearest.cause) !== null && ` (${causeLabel(hover.nearest.cause)})`}
                </div>
                <div className="muted">{hover.count} Transport(s) reported this day</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
