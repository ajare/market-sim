import { useEffect, useMemo, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { Company, SoloTrader } from "../sim/faction";

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

// SoloTrader extends Company, so `instanceof Company` catches both -- the two
// faction types are distinguished (and coloured) via the `type` tag below.
type FactionType = "company" | "solo";
const FACTION_TYPES: FactionType[] = ["company", "solo"];
const TYPE_LABEL: Record<FactionType, string> = { company: "Company", solo: "SoloTrader" };
const TYPE_VAR: Record<FactionType, string> = {
  company: "--faction-company",
  solo: "--faction-solo",
};
const TYPE_FALLBACK: Record<FactionType, string> = { company: "#2a78d6", solo: "#eb6834" };

interface CompanySeries {
  name: string;
  type: FactionType;
  /** Affiliated PoliticalEntity name, or "Independent" when unaffiliated. */
  politicalEntity: string;
  history: { day: number; netWorth: number }[];
}

interface HoverState {
  x: number;
  day: number;
  nearest: { name: string; netWorth: number; type: FactionType };
  min: number;
  max: number;
  count: number;
}

export function NetWorthHistoryPanel() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [visibleTypes, setVisibleTypes] = useState<Record<FactionType, boolean>>({
    company: true,
    solo: true,
  });

  const series: CompanySeries[] = useMemo(
    () =>
      world === null
        ? []
        : world.factions
            .filter((f) => f instanceof Company)
            .map((c) => ({
              name: c.name,
              type: (c instanceof SoloTrader ? "solo" : "company") as FactionType,
              politicalEntity: c.politicalEntity?.name ?? "Independent",
              history: c.netWorthHistory.map((r) => ({ day: r.day, netWorth: r.netWorth })),
            })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `world` is mutated in place; `version` is what actually signals new history.
    [world, version],
  );

  const visibleSeries = useMemo(
    () => series.filter((s) => visibleTypes[s.type]),
    [series, visibleTypes],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    const nonEmpty = visibleSeries.filter((s) => s.history.length > 0);
    if (nonEmpty.length === 0) {
      const ctx = canvas.getContext("2d");
      if (ctx !== null) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const allDays = [...new Set(nonEmpty.flatMap((s) => s.history.map((r) => r.day)))].sort((a, b) => a - b);

    const padL = 60;
    const padR = 16;
    const padT = 12;
    const padB = 28;
    let width = 0;
    let height = 280;
    let plotW = 0;
    let plotH = 0;
    let minDay = 0;
    let dayRange = 1;
    let yMax = 1;

    const px = (day: number) => padL + ((day - minDay) / dayRange) * plotW;
    const py = (value: number) => padT + plotH - (Math.min(value, yMax) / yMax) * plotH;
    const colorFor = (t: FactionType) => cssVar(TYPE_VAR[t], TYPE_FALLBACK[t]);

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

      plotW = width - padL - padR;
      plotH = height - padT - padB;
      minDay = allDays[0];
      const maxDay = allDays[allDays.length - 1];
      dayRange = Math.max(1, maxDay - minDay);

      const rawMax = Math.max(...nonEmpty.flatMap((s) => s.history.map((r) => r.netWorth)), 1);
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

      // One line per faction, coloured by type (blue Company / orange
      // SoloTrader) -- low opacity so overlapping same-type lines read as
      // density rather than a color-matching puzzle, while the two hues stay
      // distinguishable in aggregate.
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.3;
      for (const s of nonEmpty) {
        ctx.strokeStyle = colorFor(s.type);
        ctx.beginPath();
        s.history.forEach((r, i) => {
          const x = px(r.day);
          const y = py(r.netWorth);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function highlight(name: string, color: string): void {
      const s = nonEmpty.find((c) => c.name === name);
      if (s === undefined) return;
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      s.history.forEach((r, i) => {
        const x = px(r.day);
        const y = py(r.netWorth);
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

      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, height - padB);
      ctx.stroke();

      // Values every faction reported on this day; the entity nearest the
      // cursor's vertical position gets called out (highlighted + tooltipped)
      // so hovering means something even with many overlapping lines.
      const atDay = nonEmpty
        .map((s) => ({ name: s.name, type: s.type, record: s.history.find((r) => r.day === day) }))
        .filter(
          (e): e is { name: string; type: FactionType; record: { day: number; netWorth: number } } =>
            e.record !== undefined,
        );
      if (atDay.length === 0) return;

      let nearest = atDay[0];
      let bestDist = Infinity;
      for (const e of atDay) {
        const dist = Math.abs(py(e.record.netWorth) - mouseY);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = e;
        }
      }

      // Highlight the nearest line in its own type colour at full opacity --
      // it pops against the 0.3-alpha field while keeping its identity.
      const hlColor = colorFor(nearest.type);
      highlight(nearest.name, hlColor);

      const y = py(nearest.record.netWorth);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = hlColor;
      ctx.fill();

      const values = atDay.map((e) => e.record.netWorth);
      setHover({
        x,
        day,
        nearest: { name: nearest.name, netWorth: nearest.record.netWorth, type: nearest.type },
        min: Math.min(...values),
        max: Math.max(...values),
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
  }, [visibleSeries, version]);

  if (world === null) return null;

  const anyData = series.some((s) => s.history.length > 0);
  const nonEmpty = visibleSeries.filter((s) => s.history.length > 0);
  const hasData = nonEmpty.length > 0;
  const typeCounts: Record<FactionType, number> = {
    company: series.filter((s) => s.type === "company" && s.history.length > 0).length,
    solo: series.filter((s) => s.type === "solo" && s.history.length > 0).length,
  };
  const presentTypes = FACTION_TYPES.filter((t) => series.some((s) => s.type === t));
  const tableRows = nonEmpty
    .flatMap((s) =>
      s.history.map((r) => ({
        company: s.name, type: s.type, politicalEntity: s.politicalEntity, day: r.day, netWorth: r.netWorth,
      })),
    )
    .sort((a, b) => b.day - a.day || a.company.localeCompare(b.company));

  return (
    <div className="panel chart-panel">
      <h2>Company net worth</h2>
      <div className="chart-filters">
        {presentTypes.map((t) => (
          <label key={t}>
            <input
              type="checkbox"
              checked={visibleTypes[t]}
              onChange={() => setVisibleTypes((v) => ({ ...v, [t]: !v[t] }))}
            />
            <i className="legend-line" style={{ borderBottomColor: `var(${TYPE_VAR[t]})` }} />
            {TYPE_LABEL[t]} ({typeCounts[t]})
          </label>
        ))}
        <button type="button" onClick={() => setShowTable((v) => !v)} disabled={!hasData}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {!anyData ? (
        <p className="muted">No data yet -- step the simulation.</p>
      ) : !hasData ? (
        <p className="muted">No factions match the current filter.</p>
      ) : showTable ? (
        <div className="scroll-table">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Company</th>
                <th>Political entity</th>
                <th>Type</th>
                <th>Net worth</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={`${r.day}-${r.company}`}>
                  <td>{r.day}</td>
                  <td>{r.company}</td>
                  <td>{r.politicalEntity}</td>
                  <td>{TYPE_LABEL[r.type]}</td>
                  <td>${r.netWorth.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="chart-legend">
            {presentTypes.map((t) => (
              <span key={t}>
                <i className="legend-line" style={{ borderBottomColor: `var(${TYPE_VAR[t]})` }} />
                {TYPE_LABEL[t]} ({typeCounts[t]})
              </span>
            ))}
          </div>
          <div className="chart-canvas-wrap" ref={containerRef}>
            <canvas ref={canvasRef} />
            {hover !== null && (
              <div className="network-tooltip chart-tooltip" style={{ left: hover.x }}>
                <div className="network-tooltip-title">Day {hover.day}</div>
                <div>
                  <i
                    className="legend-line"
                    style={{ borderBottomColor: `var(${TYPE_VAR[hover.nearest.type]})` }}
                  />{" "}
                  {hover.nearest.name}: <strong>${hover.nearest.netWorth.toFixed(2)}</strong>
                </div>
                <div className="muted">
                  Range across {hover.count}: ${hover.min.toFixed(0)} - ${hover.max.toFixed(0)}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
