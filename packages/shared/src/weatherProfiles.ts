/**
 * The set of named WeatherProfiles a World can be tagged with (see
 * src/sim/weather.ts's WEATHER_PROFILES for the actual profile data, which
 * only the simulation engine needs -- the editor only needs to let the user
 * pick a name, hence this being the shared sliver rather than the whole
 * profile registry).
 */

export const WEATHER_PROFILE_NAMES = ["default", "caribbean"] as const;

export type WeatherProfileName = (typeof WEATHER_PROFILE_NAMES)[number];

export const DEFAULT_WEATHER_PROFILE_NAME: WeatherProfileName = "default";

export function isWeatherProfileName(value: unknown): value is WeatherProfileName {
  return (WEATHER_PROFILE_NAMES as readonly unknown[]).includes(value);
}

/** Human-readable name for a `<select>` option (e.g. "Caribbean"). */
export function weatherProfileDisplayName(name: WeatherProfileName): string {
  switch (name) {
    case "default":
      return "Default";
    case "caribbean":
      return "Caribbean";
  }
}
