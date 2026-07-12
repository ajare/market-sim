import { useEffect, useMemo, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { marketKey, type MarketRecord } from "../sim/markets";
import { relevantEvents, type EventMarker } from "../sim/eventOverlay";
import { EVENT_CATEGORY_LABEL, drawEventMarkerLane, eventCategoryColor, hitTestEventMarkers } from "./eventMarkers";
import { pirateNote } from "./pirateNote";

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

type HoverState =
  | { kind: "data"; x: number; day: number; buyRecord: MarketRecord | undefined; sellRecord: MarketRecord | undefined }
  | { kind: "marker"; x: number; day: number; markers: EventMarker[] };

export function PriceHistoryPanel() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [commodity, setCommodity] = useState<string | null>(null);
  const [buyLocation, setBuyLocation] = useState<string | null>(null);
  const [sellLocation, setSellLocation] = useState<string | null>(null);

  const commodityOptions = useMemo(() => {
    if (world === null) return [];
    const names = new Set<string>();
    for (const loc of world.locations) {
      for (const c of Object.keys(loc.producedCommodities)) names.add(c);
      for (const c of Object.keys(loc.consumedCommodities)) names.add(c);
    }
    return [...names].sort();
  }, [world]);

  const buyLocationOptions = useMemo(() => {
    if (world === null || commodity === null) return [];
    return world.locations.filter((l) => commodity in l.producedCommodities).map((l) => l.name);
  }, [world, commodity]);

  const sellLocationOptions = useMemo(() => {
    if (world === null || commodity === null) return [];
    return world.locations.filter((l) => commodity in l.consumedCommodities).map((l) => l.name);
  }, [world, commodity]);

  // Pick sensible defaults, and re-pick whenever the current selection no
  // longer fits the (possibly just-changed) commodity.
  useEffect(() => {
    if (world === null) return;
    if (commodity === null || !commodityOptions.includes(commodity)) {
      setCommodity(commodityOptions[0] ?? null);
      return;
    }
    if (buyLocation === null || !buyLocationOptions.includes(buyLocation)) {
      setBuyLocation(buyLocationOptions[0] ?? null);
    }
    if (sellLocation === null || !sellLocationOptions.includes(sellLocation)) {
      setSellLocation(sellLocationOptions[0] ?? null);
    }
  }, [world, commodity, commodityOptions, buyLocation, buyLocationOptions, sellLocation, sellLocationOptions]);

  const buyMarket =
    world !== null && commodity !== null && buyLocation !== null
      ? world.buyMarkets.get(marketKey(buyLocation, commodity))
      : undefined;
  const sellMarket =
    world !== null && commodity !== null && sellLocation !== null
      ? world.sellMarkets.get(marketKey(sellLocation, commodity))
      : undefined;

  // `world` is mutated in place, so `version` -- not `world` -- is what
  // actually signals that eventLog has grown since the last render.
  const markers = useMemo(() => {
    if (world === null || commodity === null) return [];
    const buy = buyLocation !== null ? relevantEvents(world.eventLog, buyLocation, commodity) : [];
    const sell = sellLocation !== null ? relevantEvents(world.eventLog, sellLocation, commodity) : [];
    return [...buy, ...sell];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, commodity, buyLocation, sellLocation, version]);
  const markerCategories = useMemo(() => [...new Set(markers.map((m) => m.category))], [markers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    const buyHistory = buyMarket?.history ?? [];
    const sellHistory = sellMarket?.history ?? [];
    if (buyHistory.length === 0 && sellHistory.length === 0) {
      const ctx = canvas.getContext("2d");
      if (ctx !== null) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const buyByDay = new Map(buyHistory.map((r) => [r.day, r]));
    const sellByDay = new Map(sellHistory.map((r) => [r.day, r]));
    const allDays = [...new Set([...buyByDay.keys(), ...sellByDay.keys()])].sort((a, b) => a - b);

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

    // Buy (produced/source) and sell (consumed/destination) prices are the
    // same two roles colored consistently elsewhere in this app (stock chart).
    const buyColor = cssVar("--accent", "#7c3aed");
    const sellColor = cssVar("--consumed", "#1baf7a");

    function drawSeries(history: MarketRecord[], color: string): void {
      const ctx = canvas!.getContext("2d");
      if (ctx === null || history.length === 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      history.forEach((r, i) => {
        const x = px(r.day);
        const y = py(r.price);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      const surface = cssVar("--panel-bg", "#ffffff");
      const last = history[history.length - 1];
      ctx.beginPath();
      ctx.arc(px(last.day), py(last.price), 6, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px(last.day), py(last.price), 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

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

      plotW = width - padL - padR;
      plotH = height - padT - padB;
      minDay = allDays[0];
      const maxDay = allDays[allDays.length - 1];
      dayRange = Math.max(1, maxDay - minDay);

      const values = [...buyHistory.map((r) => r.price), ...sellHistory.map((r) => r.price)];
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

      drawSeries(buyHistory, buyColor);
      drawSeries(sellHistory, sellColor);

      drawEventMarkerLane(ctx, markers, px, markerY, surface, cssVar);
    }

    function drawCrosshair(mouseX: number): void {
      renderStatic();
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      const frac = Math.min(1, Math.max(0, (mouseX - padL) / plotW));
      const idx = Math.round(frac * (allDays.length - 1));
      const day = allDays[idx];
      const x = px(day);

      const muted = cssVar("--muted", "#9a97a3");
      const surface = cssVar("--panel-bg", "#ffffff");

      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, height - padB);
      ctx.stroke();

      const buyRecord = buyByDay.get(day);
      const sellRecord = sellByDay.get(day);
      for (const [record, color] of [
        [buyRecord, buyColor],
        [sellRecord, sellColor],
      ] as const) {
        if (record === undefined) continue;
        const y = py(record.price);
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = surface;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }

      setHover({ kind: "data", x, day, buyRecord, sellRecord });
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
  }, [buyMarket, sellMarket, markers, version]);

  if (world === null) return null;

  const buyHistory = buyMarket?.history ?? [];
  const sellHistory = sellMarket?.history ?? [];
  const hasData = buyHistory.length > 0 || sellHistory.length > 0;
  const buyLabel = buyLocation !== null ? `Buy price at ${buyLocation}` : "Buy price";
  const sellLabel = sellLocation !== null ? `Sell price at ${sellLocation}` : "Sell price";
  const allDaysForTable = [...new Set([...buyHistory.map((r) => r.day), ...sellHistory.map((r) => r.day)])].sort(
    (a, b) => b - a,
  );
  const buyByDayForTable = new Map(buyHistory.map((r) => [r.day, r]));
  const sellByDayForTable = new Map(sellHistory.map((r) => [r.day, r]));

  return (
    <div className="panel chart-panel">
      <h2>Buy/sell prices</h2>
      <div className="chart-filters">
        <label>
          Commodity
          <select
            value={commodity ?? ""}
            onChange={(e) => setCommodity(e.target.value)}
            disabled={commodityOptions.length === 0}
          >
            {commodityOptions.length === 0 ? (
              <option value="">(none traded)</option>
            ) : (
              commodityOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))
            )}
          </select>
        </label>
        <label>
          Buy at
          <select
            value={buyLocation ?? ""}
            onChange={(e) => setBuyLocation(e.target.value)}
            disabled={buyLocationOptions.length === 0}
          >
            {buyLocationOptions.length === 0 ? (
              <option value="">(no producer)</option>
            ) : (
              buyLocationOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))
            )}
          </select>
        </label>
        <label>
          Sell at
          <select
            value={sellLocation ?? ""}
            onChange={(e) => setSellLocation(e.target.value)}
            disabled={sellLocationOptions.length === 0}
          >
            {sellLocationOptions.length === 0 ? (
              <option value="">(no consumer)</option>
            ) : (
              sellLocationOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))
            )}
          </select>
        </label>
        <button type="button" onClick={() => setShowTable((v) => !v)} disabled={!hasData}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {!hasData ? (
        <p className="muted">No data yet -- step the simulation, or pick a commodity with both a producer and a consumer.</p>
      ) : showTable ? (
        <div className="scroll-table">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>{buyLabel}</th>
                <th>{sellLabel}</th>
              </tr>
            </thead>
            <tbody>
              {allDaysForTable.map((day) => (
                <tr key={day}>
                  <td>{day}</td>
                  <td>{buyByDayForTable.get(day)?.price.toFixed(2) ?? "--"}</td>
                  <td>{sellByDayForTable.get(day)?.price.toFixed(2) ?? "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="chart-legend">
            <span>
              <i className="legend-line" style={{ borderBottomColor: "var(--accent)" }} />
              {buyLabel}
            </span>
            <span>
              <i className="legend-line" style={{ borderBottomColor: "var(--consumed)" }} />
              {sellLabel}
            </span>
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
                <div className="network-tooltip-title">Day {hover.day}</div>
                {hover.buyRecord !== undefined && (
                  <div>
                    <i className="legend-line" style={{ borderBottomColor: "var(--accent)" }} /> {buyLabel}:{" "}
                    <strong>{hover.buyRecord.price.toFixed(2)}</strong>
                    {pirateNote(hover.buyRecord) !== null && (
                      <span className="pirate-note"> ({pirateNote(hover.buyRecord)})</span>
                    )}
                  </div>
                )}
                {hover.sellRecord !== undefined && (
                  <div>
                    <i className="legend-line" style={{ borderBottomColor: "var(--consumed)" }} /> {sellLabel}:{" "}
                    <strong>{hover.sellRecord.price.toFixed(2)}</strong>
                    {pirateNote(hover.sellRecord) !== null && (
                      <span className="pirate-note"> ({pirateNote(hover.sellRecord)})</span>
                    )}
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
                    {EVENT_CATEGORY_LABEL[m.category]} ({m.location}): <strong>{m.message}</strong>{" "}
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
