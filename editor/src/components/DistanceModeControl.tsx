/**
 * Header control for the World's distance mode (see distance.ts): a Flat/Globe
 * toggle, and -- only in Globe mode -- number inputs for the sphere radius and
 * the longitude span. These drive every distance readout (route table, route
 * inspector) and the auto-routes planner, and are stored in the exported World.
 */
import { useEditorStore } from "../state/useEditorStore";

export function DistanceModeControl() {
  const distanceMode = useEditorStore((s) => s.distanceMode);
  const globeRadius = useEditorStore((s) => s.globeRadius);
  const globeLonSpan = useEditorStore((s) => s.globeLonSpan);
  const setDistanceMode = useEditorStore((s) => s.setDistanceMode);
  const setGlobeRadius = useEditorStore((s) => s.setGlobeRadius);
  const setGlobeLonSpan = useEditorStore((s) => s.setGlobeLonSpan);

  return (
    <div className="distance-mode-control">
      <label className="distance-mode-field">
        Distance
        <select value={distanceMode} onChange={(e) => setDistanceMode(e.target.value as "flat" | "globe")}>
          <option value="flat">Flat</option>
          <option value="globe">Globe</option>
        </select>
      </label>
      {distanceMode === "globe" && (
        <>
          <label className="distance-mode-field">
            Radius
            <input
              type="number"
              min={0.01}
              step={1}
              value={globeRadius}
              onChange={(e) => setGlobeRadius(Number(e.target.value))}
            />
          </label>
          <label className="distance-mode-field">
            Lon span&deg;
            <input
              type="number"
              min={1}
              max={360}
              step={1}
              value={globeLonSpan}
              onChange={(e) => setGlobeLonSpan(Number(e.target.value))}
            />
          </label>
        </>
      )}
    </div>
  );
}
