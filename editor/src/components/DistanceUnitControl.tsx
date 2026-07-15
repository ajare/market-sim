/**
 * Header control for the World's DISPLAY distance unit (see units.ts): miles
 * (default), nautical miles, or kilometers. Purely cosmetic -- drives how
 * route length/ship-speed readouts are labeled (route table, route inspector,
 * viewer) but never affects the underlying world-unit distance math. Stored
 * in the exported World (see worldJson.ts).
 */
import { useEditorStore } from "../state/useEditorStore";
import { DISTANCE_UNITS, distanceUnitName, type DistanceUnit } from "../units";

export function DistanceUnitControl() {
  const distanceUnit = useEditorStore((s) => s.distanceUnit);
  const setDistanceUnit = useEditorStore((s) => s.setDistanceUnit);

  return (
    <div className="distance-mode-control">
      <label className="distance-mode-field">
        Units
        <select value={distanceUnit} onChange={(e) => setDistanceUnit(e.target.value as DistanceUnit)}>
          {DISTANCE_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {distanceUnitName(unit)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
