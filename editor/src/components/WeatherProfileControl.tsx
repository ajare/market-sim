/**
 * Header control for the World's WeatherProfile (see src/sim/weather.ts):
 * which named climate ("Default", "Caribbean", ...) drives the simulated
 * temperature/wind/rainfall. Purely a preset picker -- profiles themselves
 * are only defined in code (WEATHER_PROFILES), not authored here. Stored in
 * the exported World (see worldJson.ts).
 */
import { useEditorStore } from "../state/useEditorStore";
import { WEATHER_PROFILE_NAMES, weatherProfileDisplayName, type WeatherProfileName } from "../weatherProfiles";

export function WeatherProfileControl() {
  const weatherProfile = useEditorStore((s) => s.weatherProfile);
  const setWeatherProfile = useEditorStore((s) => s.setWeatherProfile);

  return (
    <div className="distance-mode-control">
      <label className="distance-mode-field">
        Weather
        <select value={weatherProfile} onChange={(e) => setWeatherProfile(e.target.value as WeatherProfileName)}>
          {WEATHER_PROFILE_NAMES.map((name) => (
            <option key={name} value={name}>
              {weatherProfileDisplayName(name)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
