import { useSimStore } from "../state/useSimStore";

export function FleetPanel() {
  const world = useSimStore((s) => s.world);
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
              <th>Location</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Cash</th>
              <th>Net worth</th>
            </tr>
          </thead>
          <tbody>
            {world.captains.map((captain) => {
              const snapshot = captain.portfolioHistory[captain.portfolioHistory.length - 1];
              const netWorth = snapshot !== undefined ? snapshot.totalValue : captain.cash;
              return (
                <tr key={captain.name}>
                  <td>{captain.name}</td>
                  <td>{captain.transport?.name ?? "-"}</td>
                  <td>{captain.company?.name ?? "(independent)"}</td>
                  <td>{captain.location}</td>
                  <td>{captain.destination ?? "-"}</td>
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
