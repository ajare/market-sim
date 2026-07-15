import { useSimStore } from "../state/useSimStore";
import { marketKey } from "../sim/markets";
import { ROUTES, type Route } from "../sim/routes";
import { getDisplayDistanceUnit } from "../sim/worldData";
import { convertDistance, distanceUnitLabel } from "@market-sim/shared/units";
import { pirateNote } from "./pirateNote";

/** Every Route touching `location`, paired with the Location at its other end -- sorted by distance so the nearest connections show first. */
function connectionsFor(location: string): Array<{ other: string; route: Route }> {
  const result: Array<{ other: string; route: Route }> = [];
  // A pair can have several routes of different types (see sim/routes.ts), so
  // each list may contribute more than one connection for this Location.
  for (const routeList of ROUTES.values()) {
    for (const route of routeList) {
      if (route.origin === location) result.push({ other: route.destination, route });
      else if (route.destination === location) result.push({ other: route.origin, route });
    }
  }
  result.sort((a, b) => a.route.distance - b.route.distance);
  return result;
}

export function LocationsPanel() {
  const world = useSimStore((s) => s.world);
  if (world === null) return null;
  const unit = getDisplayDistanceUnit();
  const unitLabel = distanceUnitLabel(unit);

  return (
    <div className="panel locations-panel">
      <h2>Locations</h2>
      <div className="scroll-table">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Political Entity</th>
              <th>Connections</th>
              <th>Produces (buyable)</th>
              <th>Consumes (sellable)</th>
            </tr>
          </thead>
          <tbody>
            {world.locations.map((loc) => {
              const produced = Object.entries(loc.producedCommodities);
              const consumed = Object.entries(loc.consumedCommodities);
              const connections = connectionsFor(loc.name);
              return (
                <tr key={loc.name}>
                  <td>{loc.name}</td>
                  <td>
                    {loc.politicalEntity !== null ? loc.politicalEntity.name : <span className="muted">-</span>}
                  </td>
                  <td>
                    {connections.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      <ul className="mini-list">
                        {connections.map(({ other, route }) => (
                          <li key={`${route.routeType}-${other}`}>
                            {other} ({route.routeType}, {convertDistance(route.distance, unit).toFixed(0)} {unitLabel})
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {produced.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      <ul className="mini-list">
                        {produced.map(([commodity]) => {
                          const market = world.buyMarkets.get(marketKey(loc.name, commodity));
                          const stock = loc.stockpiles[commodity] ?? 0;
                          const rate = loc.productionRate(commodity);
                          const note = pirateNote(market?.history[market.history.length - 1]);
                          const discount = loc.discount(commodity);
                          return (
                            <li key={commodity}>
                              {commodity}: {stock.toFixed(1)} stock (+{rate.toFixed(1)}/d) @ $
                              {market !== undefined ? market.price.toFixed(2) : "-"}
                              {discount > 0 && (
                                <span className="discount-note"> (-{(discount * 100).toFixed(0)}%)</span>
                              )}
                              {note !== null && <span className="pirate-note"> ({note})</span>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                  <td>
                    {consumed.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      <ul className="mini-list">
                        {consumed.map(([commodity]) => {
                          const market = world.sellMarkets.get(marketKey(loc.name, commodity));
                          const stock = loc.stockpiles[commodity] ?? 0;
                          const min = loc.minStockpiles[commodity] ?? 0;
                          const rate = loc.consumptionRate(commodity);
                          const note = pirateNote(market?.history[market.history.length - 1]);
                          return (
                            <li key={commodity}>
                              {commodity}: {stock.toFixed(1)}/{min.toFixed(1)} min (-{rate.toFixed(1)}/d) @ $
                              {market !== undefined ? market.price.toFixed(2) : "-"}
                              {note !== null && <span className="pirate-note"> ({note})</span>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
