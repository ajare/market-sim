import { useSimStore } from "../state/useSimStore";

export function ContractsPanel() {
  const world = useSimStore((s) => s.world);
  if (world === null) return null;

  return (
    <div className="panel contracts-panel">
      <h2>Contracts</h2>
      <div className="scroll-table">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Commodity</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Delivery fee</th>
              <th>Company</th>
              <th>Tendered</th>
              <th>Expires</th>
              <th>Captain</th>
              <th>Begins</th>
              <th>Ends</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {world.contracts.map((contract) => {
              // One-shot contracts: no recurring schedule -- a contract is
              // simply open until it's accepted, serviced, and delivered
              // (fulfilled ones are pruned from world.contracts the next day).
              // Tendered/Expires describe the CONTRACT's own offer window;
              // Begins/Ends (below) describe an in-flight captain's transit,
              // a different timeline entirely.
              const captain = contract.inFlightCaptain;
              const beginsDay = captain?.cargo?.departureDay ?? null;
              const endsDay =
                captain?.cargo !== null && captain?.cargo !== undefined
                  ? captain.cargo.departureDay + captain.cargo.travelDays
                  : null;
              return (
                <tr key={`${contract.location}::${contract.commodity}`}>
                  <td>{contract.location}</td>
                  <td>{contract.commodity}</td>
                  <td>{contract.type}</td>
                  <td>{contract.quantity.toFixed(1)}</td>
                  <td>${contract.deliveryFee.toFixed(2)}</td>
                  <td>
                    {contract.fulfiller !== null ? (
                      contract.fulfiller.name
                    ) : (
                      <span className="muted">unclaimed</span>
                    )}
                  </td>
                  <td>Day {contract.beginDay}</td>
                  <td>
                    {contract.fulfiller !== null ? (
                      <span className="muted">Day {contract.expiryDay}</span>
                    ) : (
                      `Day ${contract.expiryDay}`
                    )}
                  </td>
                  <td>{captain !== null ? captain.name : <span className="muted">-</span>}</td>
                  <td>{beginsDay !== null ? `Day ${beginsDay}` : <span className="muted">-</span>}</td>
                  <td>{endsDay !== null ? `Day ${endsDay}` : <span className="muted">-</span>}</td>
                  <td>
                    {contract.fulfiller === null ? (
                      <span className="muted">unclaimed</span>
                    ) : captain !== null ? (
                      "in transit"
                    ) : (
                      <span className="muted">awaiting captain</span>
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
