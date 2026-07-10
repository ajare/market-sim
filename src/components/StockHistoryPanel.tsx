import { useEffect, useMemo, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { marketKey, type MarketRecord } from "../sim/markets";
import { relevantEvents, type EventMarker } from "../sim/eventOverlay";
import { EVENT_CATEGORY_LABEL, drawEventMarkerLane, eventCategoryColor, hitTestEventMarkers } from "./eventMarkers";

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/** Rounds a rough step up to a "nice" 1/2/5 x 10^n value so axis ticks land on clean numbers. */
function niceStep(roughStep: number): number {
  const exp = Math.floor(Math.log10(roughStep || 1));
  const base = roughStep / 10 ** exp;
  const niceBase = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return niceBase * 10 ** exp;
}

type HoverState = { kind: "data"; x: number; record: MarketRecord } | { kind: "marker"; x: number; day: number; markers: EventMarker[] };

export function StockHistoryPanel() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [location, setLocation] = useState<string | null>(null);
  const [commodity, setCommodity] = useState<string | null>(null);

  const commodityOptions = useMemo(() => {
    if (world === null || location === null) return [];
    const loc = world.locations.find((l) => l.name === location);
    if (loc === undefined) return [];
    return [...Object.keys(loc.producedCommodities), ...Object.keys(loc.consumedCommodities)];
  }, [world, location]);

  // Default to the first location/commodity once the world is available, and
  // re-pick a valid commodity whenever the location changes out from under
  // the current one (e.g. a fuel depot, which trades nothing).
  useEffect(() => {
    if (world === null) return;
    if (location === null || world.locations.every((l) => l.name !== location)) {
      setLocation(world.locations[0]?.name ?? null);
      return;
    }
    if (commodity === null || !commodityOptions.includes(commodity)) {
      setCommodity(commodityOptions[0] ?? null);
    }
  }, [world, location, commodity, commodityOptions]);

  const side: "buy" | "sell" | null =
    world === null || location === null || commodity === null
      ? null
      : world.locations.find((l) => l.name === location)?.producedCommodities[commodity] !== undefined
        ? "buy"
        : "sell";

  const market =
    world !== null && location !== null && commodity !== null && side !== null
      ? (side === "buy" ? world.buyMarkets : world.sellMarkets).get(marketKey(location, commodity))
      : undefined;

  // `world` is mutated in place (see useSimStore's doc comment), so `version`
  // -- not `world` -- is what actually signals that eventLog has grown.
  const markers = useMemo(
    () => (world === null || location === null || commodity === null ? [] : relevantEvents(world.eventLog, location, commodity)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world, location, commodity, version],
  );
  const markerCategories = useMemo(() => [...new Set(markers.map((m) => m.category))], [markers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    const history = market?.history ?? [];
    if (history.length === 0) {
      const ctx = canvas.getContext("2d");
      if (ctx !== null) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const padL = 52;
    const padR = 16;
    const padT = 30;
    const padB = 28;
    const markerY = 15;
    let width = 0;
    let height = 280;
    let plotW = 0;
    let plotH = 0;
    let minDay = 0;
    let dayRange = 1;
    let yMax = 1;

    const px = (day: number) => padL + ((day - minDay) / dayRange) * plotW;
    const py = (value: number) => padT + plotH - (Math.min(value, yMax) / yMax) * plotH;

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
      const surface = cssVar("--panel-bg", "#ffffff");
      // Produced (surplus, accumulating) and consumed (drawn down, restocked
      // by Contracts) are a genuine categorical distinction -- colored
      // consistently by role, not by current stock health.
      const lineColor = side === "sell" ? cssVar("--consumed", "#1baf7a") : cssVar("--accent", "#7c3aed");

      plotW = width - padL - padR;
      plotH = height - padT - padB;
      minDay = history[0].day;
      const maxDay = history[history.length - 1].day;
      dayRange = Math.max(1, maxDay - minDay);

      // A produced commodity's "reference" is just its frozen starting
      // stockpile, not a real floor -- only a consumed commodity's minimum
      // target is worth drawing as a threshold.
      const values = side === "sell" ? history.flatMap((r) => [r.stockpile, r.referenceStockpile]) : history.map((r) => r.stockpile);
      const rawMax = Math.max(...values, 1);
      yMax = niceStep(rawMax * 1.1);
      const yStep = niceStep(yMax / 4);

      // Gridlines -- hairline, solid, recessive.
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.fillStyle = muted;
      ctx.font = "11px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      for (let v = 0; v <= yMax + 1e-9; v += yStep) {
        const y = py(v);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(width - padR, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(Math.round(v).toLocaleString(), padL - 8, y);
      }
      const dayTicks = 5;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i <= dayTicks; i++) {
        const day = Math.round(minDay + (dayRange * i) / dayTicks);
        ctx.fillText(`Day ${day}`, px(day), height - padB + 8);
      }

      // Reference line: the minStockpile target, only meaningful for a
      // consumed commodity -- dashed to read as a threshold, not a second
      // data series. Not drawn for a produced commodity at all.
      if (side === "sell") {
        ctx.strokeStyle = muted;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        history.forEach((r, i) => {
          const x = px(r.day);
          const y = py(r.referenceStockpile);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Stockpile line -- the primary series.
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      history.forEach((r, i) => {
        const x = px(r.day);
        const y = py(r.stockpile);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // End-dot marker, ringed in the surface color so it stays legible.
      const last = history[history.length - 1];
      ctx.beginPath();
      ctx.arc(px(last.day), py(last.stockpile), 6, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px(last.day), py(last.stockpile), 4, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();

      drawEventMarkerLane(ctx, markers, px, markerY, surface, cssVar);
    }

    function drawCrosshair(mouseX: number): void {
      renderStatic();
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      const frac = Math.min(1, Math.max(0, (mouseX - padL) / plotW));
      const idx = Math.round(frac * (history.length - 1));
      const record = history[idx];
      const x = px(record.day);

      const muted = cssVar("--muted", "#9a97a3");
      const surface = cssVar("--panel-bg", "#ffffff");
      const lineColor = side === "sell" ? cssVar("--consumed", "#1baf7a") : cssVar("--accent", "#7c3aed");

      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, height - padB);
      ctx.stroke();

      const y = py(record.stockpile);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();

      setHover({ kind: "data", x, record });
    }

    function highlightMarker(day: number): void {
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      const surface = cssVar("--panel-bg", "#ffffff");
      const highlightColor = cssVar("--text-h", "#08060d");
      const x = px(day);
      ctx.strokeStyle = highlightColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, height - padB);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, markerY, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, markerY, 5, 0, Math.PI * 2);
      ctx.strokeStyle = highlightColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    function handleMouseMove(e: MouseEvent): void {
      const rect = canvas!.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const hit = hitTestEventMarkers(markers, px, markerY, mouseX, mouseY);
      if (hit !== null) {
        renderStatic();
        highlightMarker(hit.day);
        setHover({ kind: "marker", x: px(hit.day), day: hit.day, markers: hit.markers });
        return;
      }
      drawCrosshair(mouseX);
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
  }, [market, side, markers, version]);

  if (world === null) return null;

  const referenceLabel = side === "sell" ? "Minimum stockpile target" : "Reference (starting) stockpile";
  const history = market?.history ?? [];
  const lineColorVar = side === "sell" ? "var(--consumed)" : "var(--accent)";
  const roleLabel = side === "sell" ? "Consumed" : side === "buy" ? "Produced" : "";

  return (
    <div className="panel chart-panel">
      <h2>Stock levels</h2>
      <div className="chart-filters">
        <label>
          Location
          <select value={location ?? ""} onChange={(e) => setLocation(e.target.value)}>
            {world.locations.map((l) => (
              <option key={l.name} value={l.name}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Commodity
          <select
            value={commodity ?? ""}
            onChange={(e) => setCommodity(e.target.value)}
            disabled={commodityOptions.length === 0}
          >
            {commodityOptions.length === 0 ? (
              <option value="">(none traded here)</option>
            ) : (
              commodityOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))
            )}
          </select>
        </label>
        <button type="button" onClick={() => setShowTable((v) => !v)} disabled={history.length === 0}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {history.length === 0 ? (
        <p className="muted">No data yet -- step the simulation, or this location trades nothing.</p>
      ) : showTable ? (
        <div className="scroll-table">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Stockpile</th>
                <th>{referenceLabel}</th>
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().map((r) => (
                <tr key={r.day}>
                  <td>{r.day}</td>
                  <td>{r.stockpile.toFixed(1)}</td>
                  <td>{r.referenceStockpile.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="chart-legend">
            <span>
              <i className="legend-line" style={{ borderBottomColor: lineColorVar }} />
              Stockpile ({roleLabel})
            </span>
            {side === "sell" && (
              <span>
                <i className="legend-line legend-line-dashed" />
                {referenceLabel}
              </span>
            )}
            {markerCategories.map((category) => (
              <span key={category}>
                <i className="legend-swatch" style={{ background: eventCategoryColor(category, cssVar) }} />
                {EVENT_CATEGORY_LABEL[category]}
              </span>
            ))}
          </div>
          <div className="chart-canvas-wrap" ref={containerRef}>
            <canvas ref={canvasRef} />
            {hover !== null && hover.kind === "data" && (
              <div className="network-tooltip chart-tooltip" style={{ left: hover.x }}>
                <div className="network-tooltip-title">Day {hover.record.day}</div>
                <div>
                  <i className="legend-line" style={{ borderBottomColor: lineColorVar }} /> Stockpile:{" "}
                  <strong>{hover.record.stockpile.toFixed(1)}</strong>
                </div>
                {side === "sell" && (
                  <div>
                    <i className="legend-line legend-line-dashed" /> {referenceLabel}:{" "}
                    <strong>{hover.record.referenceStockpile.toFixed(1)}</strong>
                  </div>
                )}
              </div>
            )}
            {hover !== null && hover.kind === "marker" && (
              <div className="network-tooltip chart-tooltip" style={{ left: hover.x }}>
                <div className="network-tooltip-title">Day {hover.day}</div>
                {hover.markers.map((m, i) => (
                  <div key={i}>
                    <i className="legend-swatch" style={{ background: eventCategoryColor(m.category, cssVar) }} />{" "}
                    {EVENT_CATEGORY_LABEL[m.category]}: <strong>{m.message}</strong>{" "}
                    <span className="muted">({m.durationDays}d)</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
