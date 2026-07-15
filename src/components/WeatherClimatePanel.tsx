import { useEffect, useMemo, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { LOCATION_COORDINATES, getDisplayDistanceUnit } from "../sim/worldData";
import { convertSpeed, speedUnitLabel } from "@market-sim/shared/units";

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

function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(r1 + (r2 - r1) * clamped);
  const g = Math.round(g1 + (g2 - g1) * clamped);
  const b = Math.round(b1 + (b2 - b1) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Diverging blue->neutral->red across a fixed 0-40 deg C domain, matching the Network view's temperature overlay exactly (see NetworkView.tsx's TEMPERATURE_SCALE_MIN_C/MAX_C). */
function temperatureBarColor(valueC: number): string {
  const min = 0;
  const max = 40;
  const mid = (min + max) / 2;
  const cold = cssVar("--temp-cold", "#2a78d6");
  const neutral = cssVar("--temp-neutral", "#f0efec");
  const hot = cssVar("--temp-hot", "#e34948");
  if (valueC <= mid) return lerpColor(cold, neutral, (valueC - min) / (mid - min || 1));
  return lerpColor(neutral, hot, (valueC - mid) / (max - mid || 1));
}

/** Sequential ramp across the chart's own observed min/max -- wind speed has no fixed universal scale the way temperature's 0-40 deg C does, so (like the map overlay's legend) this is relative to this World's own year. */
function sequentialBarColor(value: number, min: number, max: number, lightVar: string, lightFallback: string, heavyVar: string, heavyFallback: string): string {
  const light = cssVar(lightVar, lightFallback);
  const heavy = cssVar(heavyVar, heavyFallback);
  const range = max - min;
  return lerpColor(light, heavy, range > 0 ? (value - min) / range : 0);
}

/**
 * Number of evenly-spaced days sampled within each month -- averaged
 * together with the spatial average across every Location to produce a
 * smooth "climate normal" bar per month, rather than one arbitrary noisy
 * day's reading.
 */
const DAY_SAMPLES_PER_MONTH = 4;

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface MonthlyClimate {
  /** deg C, one entry per calendar month. */
  temperatureC: number[];
  /** world-units/day (see @market-sim/shared/units), one entry per calendar month. */
  windSpeed: number[];
  /** [0,1] storminess/rainfall intensity, one entry per calendar month. */
  rainfall: number[];
}

/**
 * Averages WeatherSystem readings across every Location's position AND
 * DAY_SAMPLES_PER_MONTH days spread through each month, for a full 12-month
 * "yearly climate" picture -- deliberately NOT the sim's current day (unlike
 * the Network view's map overlay, which shows today's actual weather): this
 * is the profile's overall seasonal shape, so it only needs recomputing when
 * a new World is loaded, not every simulated day.
 */
function computeMonthlyClimate(weather: Weather, locations: readonly LocationLike[]): MonthlyClimate {
  const temperatureC = new Array(12).fill(0);
  const windSpeed = new Array(12).fill(0);
  const rainfall = new Array(12).fill(0);
  const positions = locations.map((loc) => LOCATION_COORDINATES[loc.name]).filter((p): p is [number, number] => p !== undefined);
  const sampleCount = Math.max(1, positions.length) * DAY_SAMPLES_PER_MONTH;

  for (let month = 0; month < 12; month++) {
    let tempSum = 0;
    let windSum = 0;
    let rainSum = 0;
    for (let d = 0; d < DAY_SAMPLES_PER_MONTH; d++) {
      const t = (month + (d + 0.5) / DAY_SAMPLES_PER_MONTH) / 12;
      for (const [x, y] of positions) {
        const pos = { x, y };
        tempSum += weather.temperature(t, pos);
        windSum += weather.windSpeed(t, pos);
        rainSum += weather.rainfall(t, pos);
      }
    }
    temperatureC[month] = tempSum / sampleCount;
    windSpeed[month] = windSum / sampleCount;
    rainfall[month] = rainSum / sampleCount;
  }
  return { temperatureC, windSpeed, rainfall };
}

/** Structural subset of WeatherSystem this panel needs -- avoids importing the class just for its type here. */
interface Weather {
  temperature(timeOfYear: number, position: { x: number; y: number }): number;
  windSpeed(timeOfYear: number, position: { x: number; y: number }): number;
  rainfall(timeOfYear: number, position: { x: number; y: number }): number;
}
interface LocationLike {
  name: string;
}

interface BarHover {
  x: number;
  index: number;
  value: number;
}

/**
 * One small bar chart: 12 bars (Jan-Dec), each colored by `colorFor(value)`,
 * with a per-bar hover tooltip -- a single series, so no legend box (see the
 * dataviz skill's "single series needs no legend" rule).
 */
function MiniBarChart({
  title, values, formatValue, colorFor,
}: {
  title: string;
  values: number[];
  formatValue: (v: number) => string;
  colorFor: (v: number) => string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<BarHover | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;

    const padL = 44;
    const padR = 8;
    const padT = 10;
    const padB = 20;
    let width = 0;
    const height = 160;
    let plotW = 0;
    let plotH = 0;
    let yMin = 0;
    let yMax = 1;
    let barW = 0;

    const py = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
    const bx = (i: number) => padL + i * (plotW / 12);

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
      barW = Math.max(2, plotW / 12 - 4);

      const rawMin = Math.min(...values, 0);
      const rawMax = Math.max(...values, 0);
      const pad = (rawMax - rawMin) * 0.1 || 1;
      yMin = rawMin < 0 ? rawMin - pad : 0;
      yMax = rawMax + pad;

      // Baseline (0, or yMin if every value is positive) -- bars are
      // "4px rounded data-ends anchored to the baseline" (dataviz mark spec).
      const baselineY = py(Math.max(0, yMin));
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, baselineY);
      ctx.lineTo(width - padR, baselineY);
      ctx.stroke();

      ctx.fillStyle = muted;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i < 12; i++) {
        ctx.fillText(MONTH_LABELS[i], bx(i) + plotW / 24, height - padB + 6);
      }

      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const yTop = py(yMax);
      const yBottom = py(yMin);
      ctx.fillText(formatValue(yMax), padL - 6, yTop + 4);
      ctx.fillText(formatValue(yMin), padL - 6, yBottom - 4);

      for (let i = 0; i < 12; i++) {
        const v = values[i];
        const barTop = v >= 0 ? py(v) : baselineY;
        const barBottom = v >= 0 ? baselineY : py(v);
        const cx = bx(i) + plotW / 24 - barW / 2;
        const barHeight = Math.max(1, barBottom - barTop);
        ctx.fillStyle = colorFor(v);
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          // Rounded data-end at the value, flat where the bar meets the
          // baseline (dataviz mark spec) -- which corner pair rounds flips
          // depending on whether this bar rises above or dips below zero.
          const r = Math.min(4, barW / 2, barHeight);
          if (v >= 0) ctx.roundRect(cx, barTop, barW, barHeight, [r, r, 0, 0]);
          else ctx.roundRect(cx, barTop, barW, barHeight, [0, 0, r, r]);
        } else {
          ctx.rect(cx, barTop, barW, barHeight);
        }
        ctx.fill();
      }
    }

    function handleMouseMove(e: MouseEvent): void {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const i = Math.max(0, Math.min(11, Math.floor((mx - padL) / (plotW / 12))));
      const x = bx(i) + plotW / 24;
      setHover({ x, index: i, value: values[i] });
    }
    function handleMouseLeave(): void {
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
  }, [values, formatValue, colorFor]);

  return (
    <div className="weather-climate-chart">
      <div className="weather-climate-chart-title">{title}</div>
      <div className="chart-canvas-wrap" ref={containerRef}>
        <canvas ref={canvasRef} />
        {hover !== null && (
          <div className="network-tooltip chart-tooltip" style={{ left: hover.x }}>
            <div className="network-tooltip-title">{MONTH_LABELS[hover.index]}</div>
            <div>{formatValue(hover.value)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Three small bar charts (Jan-Dec) -- the whole World's yearly-averaged
 * temperature, wind speed, and rainfall, one bar per month. Each value
 * averages every Location's position across DAY_SAMPLES_PER_MONTH days
 * spread through that month (see computeMonthlyClimate) -- a stable
 * "climate normal" picture, distinct from the Network view's map overlay
 * (which shows the current simulated day's actual weather).
 */
export function WeatherClimatePanel() {
  const world = useSimStore((s) => s.world);

  const climate = useMemo(() => {
    if (world === null || world.weather === null) return null;
    return computeMonthlyClimate(world.weather, world.locations);
  }, [world]);

  if (world === null) return null;

  const unit = getDisplayDistanceUnit();
  const speedLabel = speedUnitLabel(unit);
  const windValues = climate === null ? [] : climate.windSpeed.map((v) => convertSpeed(v, unit));
  const windMin = windValues.length > 0 ? Math.min(...windValues) : 0;
  const windMax = windValues.length > 0 ? Math.max(...windValues) : 1;
  const rainValues = climate === null ? [] : climate.rainfall.map((v) => v * 100);

  return (
    <div className="panel chart-panel">
      <h2>Yearly Climate</h2>
      {climate === null ? (
        <p className="muted">No weather data for this World.</p>
      ) : (
        <div className="weather-climate-charts">
          <MiniBarChart
            title="Temperature"
            values={climate.temperatureC}
            formatValue={(v) => `${v.toFixed(0)}°C`}
            colorFor={temperatureBarColor}
          />
          <MiniBarChart
            title={`Wind speed (${speedLabel})`}
            values={windValues}
            formatValue={(v) => `${v.toFixed(0)} ${speedLabel}`}
            colorFor={(v) => sequentialBarColor(v, windMin, windMax, "--wind-calm", "#dff5ee", "--wind-strong", "#1baf7a")}
          />
          <MiniBarChart
            title="Rainfall"
            values={rainValues}
            formatValue={(v) => `${v.toFixed(0)}%`}
            colorFor={(v) => sequentialBarColor(v, 0, 100, "--rain-light", "#b7d3f6", "--rain-heavy", "#184f95")}
          />
        </div>
      )}
    </div>
  );
}
