/**
 * Discrete, stateful storm/cyclone entities layered on top of WeatherSystem's
 * ambient noise field -- WeatherSystem itself stays a pure, standalone
 * function of (timeOfYear, position) (see weather.ts's own doc comment);
 * StormSystem is the World-level subsystem that spawns, moves, intensifies,
 * and dissipates actual Storm objects day by day, reading WeatherSystem
 * (rainfall for spawn odds, windDirection for drift, temperature/latitude
 * for cyclone formation) but never mutating it.
 *
 * Randomness draws from the shared simRandom stream (like Market's daily
 * price noise or Faction's piracy tick), not a private Rng, so a World's own
 * seed governs storm generation the same way it governs everything else
 * simulated day-to-day.
 */
import { dayToTimeOfYear, type WeatherSystem, type Position } from "./weather";
import { randRandom, randUniform } from "./simRandom";

export interface Storm {
  id: number;
  x: number;
  y: number;
  /** World units -- a Ship at or within this distance of (x, y) is "caught in it" (see stormAt). */
  radius: number;
  /** Current strength, [0, peakIntensity], recomputed every simulateDay from age via a ramp/plateau/decay curve. */
  intensity: number;
  /** Strength this Storm ramps up to at the end of its growth phase -- rolled once at spawn, fixed for its life. */
  peakIntensity: number;
  /** Days since this Storm spawned, incremented once per simulateDay call. */
  age: number;
  /** Whether this Storm has ever met the cyclone-formation criteria for CYCLONE_SUSTAIN_DAYS consecutive days -- once true, stays true even if it later drifts somewhere that no longer qualifies (a real cyclone doesn't un-become one just because it crosses cooler water). */
  isCyclone: boolean;
  /** Consecutive days (most recent unbroken streak) this Storm has met every cyclone-formation criterion -- reset to 0 the first day any criterion fails. */
  cycloneStreak: number;
}

/** Candidate spawn points sampled at random across the map each day -- not every point on the map, just a scattered sample, so spawn cost stays flat regardless of map size. */
const SPAWN_CANDIDATES_PER_DAY = 20;
/** Spawn chance per candidate point, at rainfall (storminess) 1.0 and the default STORM_FREQUENCY_MULTIPLIER -- scaled down by rainfall^2 elsewhere, so this is only ever approached during a genuinely stormy day/season, not an upper bound on how often storms actually appear. */
const BASE_SPAWN_PROBABILITY = 0.02;
/** A new Storm can't spawn within this many world units of an existing one -- keeps the map from clumping with overlapping storms. */
const MIN_STORM_SEPARATION = 800;

export const DEFAULT_STORM_FREQUENCY_MULTIPLIER = 1.0;

/**
 * Global multiplier on every candidate point's spawn chance (see trySpawn) --
 * 0 disables spawning entirely (existing Storms still move/intensify/decay
 * normally, they just aren't replaced), 2 doubles the odds, etc. Module-level
 * (like historyRetention.ts's HISTORY_RETENTION_DAYS or captain.ts's
 * SHIP_LOG_ENABLED) rather than a World field: a pure global tuning knob,
 * not part of any one World's own data, so it survives a reset()/
 * loadWorldFromJson() the same way those do.
 */
let STORM_FREQUENCY_MULTIPLIER = DEFAULT_STORM_FREQUENCY_MULTIPLIER;

export function setStormFrequency(multiplier: number): void {
  STORM_FREQUENCY_MULTIPLIER = Math.max(0, multiplier);
}

export function getStormFrequency(): number {
  return STORM_FREQUENCY_MULTIPLIER;
}

const STORM_MIN_RADIUS = 300;
const STORM_MAX_RADIUS = 700;
/** Peak intensity is rolled uniformly in this range at spawn -- every Storm ramps to *some* real strength, none are spawned trivially weak. */
const MIN_PEAK_INTENSITY = 0.4;
const MAX_PEAK_INTENSITY = 1.0;

/** Days to ramp intensity 0 -> peakIntensity after spawning. */
const GROWTH_DAYS = 4;
/** Days spent at peak intensity before decay begins. */
const PLATEAU_DAYS = 3;
/** Days to decay from peak intensity back to 0. */
const DECAY_DAYS = 6;
/** Hard cap on a Storm's total lifespan regardless of its intensity curve -- a safety net, not expected to bind under the ramp/plateau/decay numbers above (4+3+6=13 days). */
const MAX_LIFESPAN_DAYS = 20;

/** World units/day a Storm drifts, following the local wind direction. */
const MOVEMENT_SPEED = 150;
/** Random wobble (degrees, +-) added to the local wind heading each day, so a Storm's track isn't perfectly straight. */
const MOVEMENT_WOBBLE_DEG = 25;

/** A Storm can only form a cyclone where the water is this warm (deg C) -- matches the real-world tropical-cyclone threshold (~26.5 deg C), see WeatherSystem.temperature. */
const CYCLONE_MIN_TEMPERATURE_C = 26;
/** Minimum |latitude| (degrees) for cyclone formation -- too close to the equator and there's essentially no Coriolis effect to organize a real cyclone's rotation. */
const CYCLONE_MIN_LATITUDE = 5;
/** Maximum |latitude| (degrees) for cyclone formation -- the tropics only; too far poleward and the water's too cold anyway (see CYCLONE_MIN_TEMPERATURE_C), but this keeps the band explicit. */
const CYCLONE_MAX_LATITUDE = 30;
/** Minimum intensity a Storm must sustain to be eligible to become a cyclone. */
const CYCLONE_MIN_INTENSITY = 0.6;
/** Consecutive days every cyclone-formation criterion must hold before a Storm actually escalates. */
const CYCLONE_SUSTAIN_DAYS = 3;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0 at spawn, ramps linearly to 1 over GROWTH_DAYS, holds at 1 for PLATEAU_DAYS, decays linearly back to 0 over DECAY_DAYS, then stays 0. */
function intensityCurveFraction(age: number): number {
  if (age < GROWTH_DAYS) return age / GROWTH_DAYS;
  if (age < GROWTH_DAYS + PLATEAU_DAYS) return 1;
  const decayAge = age - GROWTH_DAYS - PLATEAU_DAYS;
  if (decayAge < DECAY_DAYS) return 1 - decayAge / DECAY_DAYS;
  return 0;
}

/** The most intense Storm (if any) whose radius currently covers `position` -- what a Captain departing from that position is "caught in." Null if none. */
export function stormAt(storms: readonly Storm[], position: Position): Storm | null {
  let best: Storm | null = null;
  for (const storm of storms) {
    const dist = Math.hypot(storm.x - position.x, storm.y - position.y);
    if (dist > storm.radius) continue;
    if (best === null || storm.intensity > best.intensity) best = storm;
  }
  return best;
}

export class StormSystem {
  storms: Storm[] = [];
  private nextId = 1;

  /** Moves/ages/escalates every existing Storm (dropping any that dissipate), then rolls new spawns -- called once per simulated day (see World.runDay). */
  simulateDay(day: number, weather: WeatherSystem, startDate: Date): void {
    const t = dayToTimeOfYear(day, startDate);
    this.advanceExisting(t, weather);
    this.trySpawn(t, weather);
  }

  private advanceExisting(t: number, weather: WeatherSystem): void {
    const survivors: Storm[] = [];
    for (const storm of this.storms) {
      storm.age += 1;
      storm.intensity = intensityCurveFraction(storm.age) * storm.peakIntensity;
      if (storm.age >= MAX_LIFESPAN_DAYS) continue;
      if (storm.age > GROWTH_DAYS + PLATEAU_DAYS && storm.intensity < 0.02) continue;

      const heading = weather.windDirection(t, { x: storm.x, y: storm.y });
      const actualHeading = heading + randUniform(-MOVEMENT_WOBBLE_DEG, MOVEMENT_WOBBLE_DEG);
      const rad = (actualHeading * Math.PI) / 180;
      storm.x += Math.sin(rad) * MOVEMENT_SPEED;
      storm.y += -Math.cos(rad) * MOVEMENT_SPEED;

      const position = { x: storm.x, y: storm.y };
      const latitude = Math.abs(weather.latitudeDeg(position));
      const temperature = weather.temperature(t, position);
      const meetsCycloneCriteria =
        temperature > CYCLONE_MIN_TEMPERATURE_C
        && latitude > CYCLONE_MIN_LATITUDE
        && latitude < CYCLONE_MAX_LATITUDE
        && storm.intensity > CYCLONE_MIN_INTENSITY;
      storm.cycloneStreak = meetsCycloneCriteria ? storm.cycloneStreak + 1 : 0;
      if (storm.cycloneStreak >= CYCLONE_SUSTAIN_DAYS) storm.isCyclone = true;

      survivors.push(storm);
    }
    this.storms = survivors;
  }

  private trySpawn(t: number, weather: WeatherSystem): void {
    const { x0, y0, x1, y1 } = weather.bounds;
    for (let i = 0; i < SPAWN_CANDIDATES_PER_DAY; i++) {
      const x = randUniform(x0, x1);
      const y = randUniform(y0, y1);
      const rain = weather.rainfall(t, { x, y });
      const chance = BASE_SPAWN_PROBABILITY * rain * rain * STORM_FREQUENCY_MULTIPLIER;
      if (randRandom() >= chance) continue;
      if (this.storms.some((s) => Math.hypot(s.x - x, s.y - y) < MIN_STORM_SEPARATION)) continue;

      const peakIntensity = randUniform(MIN_PEAK_INTENSITY, MAX_PEAK_INTENSITY);
      this.storms.push({
        id: this.nextId++,
        x,
        y,
        radius: lerp(STORM_MIN_RADIUS, STORM_MAX_RADIUS, peakIntensity),
        intensity: 0,
        peakIntensity,
        age: 0,
        isCyclone: false,
        cycloneStreak: 0,
      });
    }
  }
}
