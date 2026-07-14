import { useSimStore } from "../state/useSimStore";
import { travelDaysBetween } from "../sim/worldData";

export function FleetPanel() {
  const world = useSimStore((s) => s.world);
  const selectedCaptain = useSimStore((s) => s.selectedCaptain);
  const selectTransport = useSimStore((s) => s.selectTransport);
  if (world === null) return null;

  return (
    <div className="panel fleet-panel">
      <h2>Fleet</h2>
      <div className="scroll-table">
        <table>
          <thead>
            <tr>
              <th>Captain</th>
              <th>Ship</th>
              <th>Faction</th>
              <th>Political entity</th>
              <th>Location</th>
              <th>Destination</th>
              <th>Days</th>
              <th>Status</th>
              <th>Cash</th>
              <th>Net worth</th>
            </tr>
          </thead>
          <tbody>
            {world.captains.map((captain, i) => {
              const snapshot = captain.portfolioHistory[captain.portfolioHistory.length - 1];
              const netWorth = snapshot !== undefined ? snapshot.totalValue : captain.cash;
              const totalDays =
                captain.destination !== null && captain.transport !== null
                  ? travelDaysBetween(captain.locationName, captain.destination, captain.transport.speedUnitsPerDay)
                  : null;
              // Captain names aren't unique across the fleet (the procedural
              // world reuses first/last names), so key by index -- the fleet is
              // replaced wholesale on a new World, never reordered in place, so
              // an index key reconciles correctly and avoids stale rows lingering
              // after a Paste World swaps the whole fleet out.
              return (
                <tr
                  key={i}
                  className={captain === selectedCaptain ? "fleet-row-selected" : undefined}
                  onClick={() => selectTransport(captain)}
                >
                  <td>{captain.name}</td>
                  <td>{captain.transport?.name ?? "-"}</td>
                  <td>{captain.company?.name ?? "(independent)"}</td>
                  <td>{captain.company?.politicalEntity?.name ?? "Independent"}</td>
                  <td>{captain.locationName}</td>
                  <td>{captain.destination ?? "-"}</td>
                  <td>{totalDays !== null ? `${captain.daysRemaining}d of ${totalDays}d` : "-"}</td>
                  <td>{captain.status}</td>
                  <td>${captain.cash.toFixed(2)}</td>
                  <td>${netWorth.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
