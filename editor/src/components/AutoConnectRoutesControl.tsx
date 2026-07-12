/**
 * Header control that bulk-adds straight Sea routes between sea-capable ports.
 * The two number inputs are world-unit thresholds (see autoRoutes.ts):
 *  - detour distance: don't connect a pair directly if another port lies
 *    within this distance of the line between them (0 disables the check);
 *  - max distance: don't connect a pair whose straight route would be longer
 *    than this.
 * Clicking plans the pairs from the live store, confirms the count, then adds
 * them and reports how many were added. The thresholds are transient UI state
 * -- they are not part of the exported World.
 */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";
import { planAutoSeaRoutes } from "../autoRoutes";

const DEFAULT_DETOUR_DISTANCE = 10;
const DEFAULT_MAX_DISTANCE = 50;

export function AutoConnectRoutesControl() {
  const addRoutesForPairs = useEditorStore((s) => s.addRoutesForPairs);
  const clearRoutes = useEditorStore((s) => s.clearRoutes);
  // Subscribe to locations so the button re-evaluates its disabled state as
  // Locations are added/removed; the plan itself reads the live store on click.
  const locationCount = useEditorStore((s) => s.locations.length);
  const routeCount = useEditorStore((s) => s.routes.length);
  const [detourDistance, setDetourDistance] = useState(DEFAULT_DETOUR_DISTANCE);
  const [maxDistance, setMaxDistance] = useState(DEFAULT_MAX_DISTANCE);

  function handleClick() {
    const state = useEditorStore.getState();
    const pairs = planAutoSeaRoutes(
      state.locations,
      state.routes,
      Math.max(0, detourDistance),
      maxDistance,
      state.distanceConfig(),
    );
    if (pairs.length === 0) {
      window.alert("No Sea routes to add with these settings.");
      return;
    }
    const plural = pairs.length === 1 ? "" : "s";
    if (!window.confirm(`Add ${pairs.length} Sea route${plural}?`)) return;
    addRoutesForPairs(pairs, "Sea");
    window.alert(`Added ${pairs.length} Sea route${plural}.`);
  }

  function handleDeleteAll() {
    const plural = routeCount === 1 ? "" : "s";
    if (!window.confirm(`Delete all ${routeCount} route${plural}?`)) return;
    clearRoutes();
  }

  return (
    <div className="auto-routes-control">
      <label className="auto-routes-field">
        detour
        <input
          type="number"
          min={0}
          value={detourDistance}
          onChange={(e) => setDetourDistance(Number(e.target.value))}
        />
      </label>
      <label className="auto-routes-field">
        max
        <input
          type="number"
          min={0}
          value={maxDistance}
          onChange={(e) => setMaxDistance(Number(e.target.value))}
        />
      </label>
      <button type="button" onClick={handleClick} disabled={locationCount < 2}>
        Auto-connect Sea routes
      </button>
      <button type="button" onClick={handleDeleteAll} disabled={routeCount === 0}>
        Delete all routes
      </button>
    </div>
  );
}
