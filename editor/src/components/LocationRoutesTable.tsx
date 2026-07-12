/**
 * Table of every Route touching one Location -- the other end, its
 * RouteType, and the live length of its (possibly bent, via shift-dragged
 * control points -- see WorldCanvas) path between the two Locations'
 * current positions, recomputed on render rather than stored on the Route
 * so it never goes stale after a Location is dragged or a control point is
 * moved -- plus a button to delete the Route. Routes are only ever created
 * via WorldCanvas's shift-drag (see useEditorStore.addRoute); this table is
 * read/delete-only.
 */
import { useEditorStore } from "../state/useEditorStore";
import { deriveRouteCurveType, routePathLength, type EditorLocation } from "../types";

export function LocationRoutesTable({ locationId }: { locationId: string }) {
  const locations = useEditorStore((s) => s.locations);
  const routes = useEditorStore((s) => s.routes);
  const removeRoute = useEditorStore((s) => s.removeRoute);
  const worldScale = useEditorStore((s) => s.worldScale);

  const location = locations.find((loc) => loc.id === locationId);
  if (location === undefined) return null;

  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const connections = routes
    .map((route) => {
      // Only Routes that actually touch this Location -- otherwise every Route
      // in the World would show up here (a Route not involving this Location
      // still has a defined "other" end, so it must be excluded explicitly).
      if (route.locationAId !== locationId && route.locationBId !== locationId) return null;
      const otherId = route.locationAId === locationId ? route.locationBId : route.locationAId;
      const other = locationById.get(otherId);
      if (other === undefined) return null;
      return { route, other };
    })
    .filter((entry): entry is { route: (typeof routes)[number]; other: EditorLocation } => entry !== null);

  return (
    <div className="routes-table-section">
      <div className="field-label">Routes</div>
      {connections.length === 0 ? (
        <div className="routes-empty">No routes yet -- shift-drag from this Location to another to create one.</div>
      ) : (
        <table className="routes-table">
          <thead>
            <tr>
              <th>To</th>
              <th>Type</th>
              <th>Curve</th>
              <th>Distance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connections.map(({ route, other }) => (
              <tr key={route.id}>
                <td className="routes-table-name-cell">{other.name}</td>
                <td>{route.routeType}</td>
                <td>{deriveRouteCurveType(route.controlPoints.length)}</td>
                <td>{(routePathLength(location, other, route.controlPoints) * worldScale).toFixed(1)}</td>
                <td>
                  <button type="button" onClick={() => removeRoute(route.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
