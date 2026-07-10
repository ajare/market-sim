import { useSimStore } from "../state/useSimStore";
import { marketKey } from "../sim/markets";

export function LocationsPanel() {
  const world = useSimStore((s) => s.world);
  if (world === null) return null;

  return (
    <div className="panel locations-panel">
      <h2>Locations</h2>
      <div className="scroll-table">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Cash</th>
              <th>Produces (buyable)</th>
              <th>Consumes (sellable)</th>
            </tr>
          </thead>
          <tbody>
            {world.locations.map((loc) => {
              const produced = Object.entries(loc.producedCommodities);
              const consumed = Object.entries(loc.consumedCommodities);
              return (
                <tr key={loc.name}>
                  <td>{loc.name}</td>
                  <td>{loc.cash <= 0 ? <span className="muted">broke</span> : `$${loc.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</td>
                  <td>
                    {produced.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      <ul className="mini-list">
                        {produced.map(([commodity, rate]) => {
                          const market = world.buyMarkets.get(marketKey(loc.name, commodity));
                          const stock = loc.stockpiles[commodity] ?? 0;
                          return (
                            <li key={commodity}>
                              {commodity}: {stock.toFixed(1)} stock (+{rate.toFixed(1)}/d) @ $
                              {market !== undefined ? market.price.toFixed(2) : "-"}
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
                        {consumed.map(([commodity, rate]) => {
                          const market = world.sellMarkets.get(marketKey(loc.name, commodity));
                          const stock = loc.stockpiles[commodity] ?? 0;
                          const min = loc.minStockpiles[commodity] ?? 0;
                          return (
                            <li key={commodity}>
                              {commodity}: {stock.toFixed(1)}/{min.toFixed(1)} min (-{rate.toFixed(1)}/d) @ $
                              {market !== undefined ? market.price.toFixed(2) : "-"}
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
