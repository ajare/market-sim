/**
 * Inspector panel for the currently selected Route (see WorldCanvas /
 * selectRoute): its two endpoints, length, curve, and a RouteType selector
 * restricted to the types both endpoints' terminals actually support (see
 * compatibleRouteTypes), plus a Delete button. Renders nothing at all when no
 * Route is selected.
 */
import { useEditorStore } from "../state/useEditorStore";
import { compatibleRouteTypes, deriveRouteCurveType, routePathLength, sortRouteControlPoints, type RouteType } from "../types";

export function RouteInspector() {
  const route = useEditorStore((s) => s.routes.find((r) => r.id === s.selectedRouteId));
  const locations = useEditorStore((s) => s.locations);
  const setRouteType = useEditorStore((s) => s.setRouteType);
  const removeRoute = useEditorStore((s) => s.removeRoute);
  const removeRouteControlPoint = useEditorStore((s) => s.removeRouteControlPoint);
  const worldScale = useEditorStore((s) => s.worldScale);

  // Nothing selected (or a dangling id) -> show nothing in the panel.
  if (route === undefined) return null;
  const a = locations.find((l) => l.id === route.locationAId);
  const b = locations.find((l) => l.id === route.locationBId);
  if (a === undefined || b === undefined) return null;

  const allowedTypes = compatibleRouteTypes(a.terminalTypes, b.terminalTypes);
  // Positions are normalized [0,1]; the world length is the normalized length
  // scaled by worldScale (a uniform multiplier on both axes).
  const length = routePathLength(a, b, route.controlPoints) * worldScale;
  // Ordered along the Route (origin -> destination), the same order the canvas
  // draws and measures them, so the list reads left-to-right along the path.
  const sortedControlPoints = sortRouteControlPoints(a, b, route.controlPoints);

  return (
    <div className="inspector">
      <div className="inspector-header">
        <span className="route-inspector-title">Route</span>
        <button type="button" className="delete-button" onClick={() => removeRoute(route.id)}>
          Delete
        </button>
      </div>

      <div className="route-inspector-endpoints">
        {a.name} &harr; {b.name}
      </div>

      <label className="field-row route-type-field">
        Type
        <select
          value={route.routeType}
          onChange={(e) => setRouteType(route.id, e.target.value as RouteType)}
        >
          {allowedTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <dl className="route-inspector-info">
        <div>
          <dt>Curve</dt>
          <dd>{deriveRouteCurveType(route.controlPoints.length)}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{length.toFixed(1)}</dd>
        </div>
      </dl>

      <div className="route-control-points">
        <div className="field-label">Control points ({sortedControlPoints.length})</div>
        {sortedControlPoints.length === 0 ? (
          <div className="route-control-points-empty">None -- shift-drag on the Route to add one.</div>
        ) : (
          <ul className="route-control-points-list">
            {sortedControlPoints.map((p, i) => (
              <li key={p.id}>
                <span className="route-control-point-label">
                  #{i + 1} &middot; ({Math.round(p.x * worldScale)}, {Math.round(p.y * worldScale)})
                </span>
                <button
                  type="button"
                  title="Delete control point"
                  onClick={() => removeRouteControlPoint(route.id, p.id)}
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
