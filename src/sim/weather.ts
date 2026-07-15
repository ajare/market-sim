/**
 * A standalone, queryable weather field: wind speed/direction, temperature,
 * and rainfall as pure functions of (timeOfYear, position), shaped by a
 * WeatherProfile (see below) -- the profile owns every climate constant, so
 * "what kind of climate is this" is a data choice, not a code change.
 *
 * Not wired into World/Transport/Captain -- this is a data source other code
 * can query later, not a simulated process with its own state.
 *
 * Determinism is via hashed value noise (not the Rng/simRandom stream
 * classes) so that repeated queries at the same input are always identical
 * regardless of call order -- see hash3/valueNoise3D below.
 */
import type { WeatherProfileName } from "@market-sim/shared/weatherProfiles";

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Cells of noise per bounds width/height -- sets the spatial correlation length of weather fronts. */
const SPATIAL_CELLS = 8;
/** Cells of noise per year -- sets how many days a weather front persists before the pattern shifts. */
const TEMPORAL_CELLS = 12;

/** Salts distinguish independent noise fields drawn from the same base seed. */
const STORMINESS_SALT = 0x9e3779b1;
const WIND_DIRECTION_SALT = 0x85ebca77;

/** Real-Earth conversion used to turn a World's y-extent (world units == miles, see @market-sim/shared/units) into actual degrees of latitude. */
const MILES_PER_DEGREE_LATITUDE = 69;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function wrapInt(n: number, period: number): number {
  return ((n % period) + period) % period;
}

/** Wraps a degree value into [0, 360). */
function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Deterministic hash of (seed, x, y, z) to a float in [0, 1). */
function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ x, 0x27d4eb2f);
  h = Math.imul(h ^ y, 0x165667b1);
  h = Math.imul(h ^ z, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Value noise in [0, 1] over continuous (x, y, z), smoothly interpolated
 * between the 8 surrounding integer lattice points. The z (time) axis wraps
 * with period `tPeriod` so a cyclical timeOfYear stays seamless year to year.
 */
function valueNoise3D(seed: number, x: number, y: number, z: number, tPeriod: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const fz = smoothstep(z - z0);
  const wz0 = wrapInt(z0, tPeriod);
  const wz1 = wrapInt(z1, tPeriod);

  const c000 = hash3(seed, x0, y0, wz0);
  const c100 = hash3(seed, x1, y0, wz0);
  const c010 = hash3(seed, x0, y1, wz0);
  const c110 = hash3(seed, x1, y1, wz0);
  const c001 = hash3(seed, x0, y0, wz1);
  const c101 = hash3(seed, x1, y0, wz1);
  const c011 = hash3(seed, x0, y1, wz1);
  const c111 = hash3(seed, x1, y1, wz1);

  const c00 = lerp(c000, c100, fx);
  const c10 = lerp(c010, c110, fx);
  const c01 = lerp(c001, c101, fx);
  const c11 = lerp(c011, c111, fx);

  const c0 = lerp(c00, c10, fy);
  const c1 = lerp(c01, c11, fy);

  return lerp(c0, c1, fz);
}

export interface Position {
  x: number;
  y: number;
}

/**
 * A simulated day number (1-indexed, matching World.runDay's `day` param)
 * converted to WeatherSystem's timeOfYear convention, given the World's own
 * day-1 calendar date. A pure function that doesn't reach into worldData.ts's
 * module state itself, keeping this file standalone (see the top-of-file
 * doc comment) -- callers pass their own start date (e.g. worldData.ts's
 * getWorldStartDate()).
 */
export function dayToTimeOfYear(day: number, startDate: Date): number {
  const date = new Date(startDate);
  date.setUTCDate(date.getUTCDate() + (day - 1));
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const startOfNextYear = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  return (date.getTime() - startOfYear) / (startOfNextYear - startOfYear);
}

/**
 * Every climate constant WeatherSystem needs, keyed to two reference
 * latitudes ("warm" and "cool") rather than hardcoded equator/pole values --
 * generalizes the old fixed 0deg/90deg model so a profile can represent a
 * narrow real-world band (e.g. the Caribbean, ~10-25degN) instead of always
 * spanning a full hot-equator-to-cold-pole gradient. A position's actual
 * latitude (see WeatherSystem.latitudeDeg) interpolates between the two
 * anchors, clamped at both ends -- no extrapolation past either one.
 */
export interface WeatherProfile {
  /** Display name (e.g. "Caribbean"). */
  name: string;
  /** The real-world latitude (degrees, north positive) this World's y-center corresponds to. */
  centerLatitudeDeg: number;
  /** The warmer reference latitude (Default: 0, the equator). */
  warmLatitudeDeg: number;
  warmTemperatureC: number;
  warmSeasonalAmplitudeC: number;
  /** The cooler reference latitude (Default: 90, a pole). */
  coolLatitudeDeg: number;
  coolTemperatureC: number;
  coolSeasonalAmplitudeC: number;
  /** How much a fully stormy day (storminess 1) cools temperature below its seasonal/latitude baseline, deg C. */
  stormCoolingC: number;
  /** Wind speed base (world-units/day) at the warm/cool latitude anchors -- boosted further by storminess, same as temperature's cooling. */
  warmWindBase: number;
  coolWindBase: number;
  stormWindBoost: number;
  /**
   * The prevailing (mean) wind heading, degrees clockwise from north, in the
   * SAME "arrow points this way" convention as windDirection()'s return
   * value (so e.g. the Caribbean's NE trade winds -- which blow FROM the
   * ENE, TOWARD the WSW -- use ~245, not 65). Null means no prevailing
   * direction at all: windDirection() falls back to pure noise, uniformly
   * random over the full circle (the original, pre-profile behavior).
   */
  prevailingWindDirectionDeg: number | null;
  /** How far the noise-driven wobble can swing away from prevailingWindDirectionDeg, degrees. Ignored when prevailingWindDirectionDeg is null. */
  windDirectionSpreadDeg: number;
  /** timeOfYear [0,1) the wet season peaks at (e.g. ~0.67 for the Caribbean's Aug-Sep hurricane season). Ignored when wetSeasonAmplitude is 0. */
  wetSeasonPeakTimeOfYear: number;
  /** How much wetter the peak wet-season day gets vs. the driest day of the year, added on top of the spatial/temporal noise. 0 means no seasonal rainfall bias at all (the original, pre-profile behavior). */
  wetSeasonAmplitude: number;
}

/**
 * The built-in named profiles a World can be tagged with (see
 * @market-sim/shared/weatherProfiles's WEATHER_PROFILE_NAMES, the shared
 * sliver the editor's picker needs) -- "default" exactly reproduces this
 * module's original hardcoded behavior (equator-to-pole gradient, fully
 * random wind direction, no rainfall seasonality); "caribbean" is a narrow
 * ~10-25degN tropical band with consistent NE trade winds and an Aug-Sep
 * wet season.
 */
export const WEATHER_PROFILES: Record<WeatherProfileName, WeatherProfile> = {
  default: {
    name: "Default",
    centerLatitudeDeg: 0,
    warmLatitudeDeg: 0,
    warmTemperatureC: 28,
    warmSeasonalAmplitudeC: 3,
    coolLatitudeDeg: 90,
    coolTemperatureC: -15,
    coolSeasonalAmplitudeC: 18,
    stormCoolingC: 8,
    warmWindBase: 80,
    coolWindBase: 220,
    stormWindBoost: 260,
    prevailingWindDirectionDeg: null,
    windDirectionSpreadDeg: 180,
    wetSeasonPeakTimeOfYear: 0,
    wetSeasonAmplitude: 0,
  },
  caribbean: {
    name: "Caribbean",
    centerLatitudeDeg: 17,
    warmLatitudeDeg: 10,
    warmTemperatureC: 27,
    warmSeasonalAmplitudeC: 2,
    coolLatitudeDeg: 25,
    coolTemperatureC: 24,
    coolSeasonalAmplitudeC: 5,
    stormCoolingC: 6,
    warmWindBase: 360,
    coolWindBase: 400,
    stormWindBoost: 450,
    prevailingWindDirectionDeg: 245,
    windDirectionSpreadDeg: 35,
    wetSeasonPeakTimeOfYear: 0.67,
    wetSeasonAmplitude: 0.35,
  },
};

export class WeatherSystem {
  private readonly seed: number;
  /** Public so callers (e.g. the Network view's overlay grid) can sample an evenly-spaced set of points across the same span this WeatherSystem was built against, without duplicating it. */
  readonly bounds: Bounds;
  private readonly profile: WeatherProfile;

  constructor(seed: number, bounds: Bounds, profile: WeatherProfile) {
    this.seed = seed | 0;
    this.bounds = bounds;
    this.profile = profile;
  }

  /**
   * A position's real-world latitude, degrees (north positive), derived from
   * how far it sits (in world units == miles) from the World's vertical
   * center, converted via MILES_PER_DEGREE_LATITUDE and offset by the
   * profile's centerLatitudeDeg -- NOT a bare fraction of the bounds height
   * the way the pre-profile model worked, so a small map genuinely doesn't
   * span much real latitude, and a large one can span a full hemisphere.
   * Clamped to +-90 (a physical pole) regardless of how tall the map is.
   * Public (not just used internally for temperature/wind) since other
   * systems keyed to real-world latitude bands -- e.g. storms.ts's cyclone
   * formation check (needs "away from the equator, still tropical") -- need
   * the same computation rather than duplicating it.
   */
  latitudeDeg(position: Position): number {
    const yCenter = (this.bounds.y0 + this.bounds.y1) / 2;
    const offsetDeg = (yCenter - position.y) / MILES_PER_DEGREE_LATITUDE;
    return clamp(this.profile.centerLatitudeDeg + offsetDeg, -90, 90);
  }

  /**
   * [0,1] interpolation fraction between the profile's warm and cool
   * latitude anchors for this position's (absolute) latitude, clamped at
   * both ends -- 0 at or equatorward of warmLatitudeDeg, 1 at or poleward of
   * coolLatitudeDeg.
   */
  private latitudeFraction(position: Position): number {
    const { warmLatitudeDeg, coolLatitudeDeg } = this.profile;
    const span = coolLatitudeDeg - warmLatitudeDeg;
    if (span === 0) return 0;
    const lat = Math.abs(this.latitudeDeg(position));
    return clamp((lat - warmLatitudeDeg) / span, 0, 1);
  }

  private latticeCoords(timeOfYear: number, position: Position): { nx: number; ny: number; nt: number } {
    const { x0, y0, x1, y1 } = this.bounds;
    const xSpan = x1 - x0;
    const ySpan = y1 - y0;
    const xFrac = xSpan === 0 ? 0 : (position.x - x0) / xSpan;
    const yFrac = ySpan === 0 ? 0 : (position.y - y0) / ySpan;
    return {
      nx: xFrac * SPATIAL_CELLS,
      ny: yFrac * SPATIAL_CELLS,
      nt: timeOfYear * TEMPORAL_CELLS,
    };
  }

  /**
   * Shared [0, 1] storminess field driving rainfall, wind speed, and
   * temperature together, with the profile's wet-season bias (if any) added
   * on top of the base spatial/temporal noise -- a raised-cosine term
   * peaking at wetSeasonPeakTimeOfYear and troughing exactly half a year
   * later, scaled by wetSeasonAmplitude (0 for "default", so this reduces
   * to plain noise with no seasonal skew, the original behavior).
   */
  private storminess(timeOfYear: number, position: Position): number {
    const { nx, ny, nt } = this.latticeCoords(timeOfYear, position);
    const base = valueNoise3D(this.seed ^ STORMINESS_SALT, nx, ny, nt, TEMPORAL_CELLS);
    const { wetSeasonAmplitude, wetSeasonPeakTimeOfYear } = this.profile;
    if (wetSeasonAmplitude === 0) return base;
    const seasonalFactor = 0.5 * (1 + Math.cos(2 * Math.PI * (timeOfYear - wetSeasonPeakTimeOfYear)));
    return clamp(base + wetSeasonAmplitude * (seasonalFactor - 0.5), 0, 1);
  }

  /**
   * Degrees Celsius. `timeOfYear` follows the sim's own calendar convention
   * (see worldData.ts's DEFAULT_START_DATE / World.startDate): 0 is Jan 1,
   * 1 is the following Jan 1 -- so the seasonal term below is phased to peak
   * at timeOfYear 0.5 (around July, the summer months) and trough at 0/1
   * (around January, winter), not an arbitrary offset.
   */
  temperature(timeOfYear: number, position: Position): number {
    const p = this.profile;
    const f = this.latitudeFraction(position);
    const baseline = lerp(p.warmTemperatureC, p.coolTemperatureC, f);
    const amplitude = lerp(p.warmSeasonalAmplitudeC, p.coolSeasonalAmplitudeC, f);
    const seasonal = -amplitude * Math.cos(2 * Math.PI * timeOfYear);
    const cooling = p.stormCoolingC * this.storminess(timeOfYear, position);
    return baseline + seasonal - cooling;
  }

  rainfall(timeOfYear: number, position: Position): number {
    return this.storminess(timeOfYear, position);
  }

  windSpeed(timeOfYear: number, position: Position): number {
    const p = this.profile;
    const f = this.latitudeFraction(position);
    const base = lerp(p.warmWindBase, p.coolWindBase, f);
    const boost = p.stormWindBoost * this.storminess(timeOfYear, position);
    return base + boost;
  }

  /**
   * Degrees [0, 360) clockwise from north, "arrow points this way" (matching
   * the Network view's arrow overlay and prevailingWindDirectionDeg's own
   * convention). With no prevailing direction (profile.prevailingWindDirectionDeg
   * null), this is pure noise, uniformly random over the full circle --
   * otherwise it's the prevailing heading plus a noise-driven wobble bounded
   * by +-windDirectionSpreadDeg.
   */
  windDirection(timeOfYear: number, position: Position): number {
    const { nx, ny, nt } = this.latticeCoords(timeOfYear, position);
    const noise = valueNoise3D(this.seed ^ WIND_DIRECTION_SALT, nx, ny, nt, TEMPORAL_CELLS);
    const { prevailingWindDirectionDeg, windDirectionSpreadDeg } = this.profile;
    if (prevailingWindDirectionDeg === null) return noise * 360;
    const offset = (noise - 0.5) * 2 * windDirectionSpreadDeg;
    return wrap360(prevailingWindDirectionDeg + offset);
  }
}
