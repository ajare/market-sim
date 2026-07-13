import { useSimStore } from "../state/useSimStore";
import { Ship, crewSpeedFraction } from "../sim/transport";
import { Sailor } from "../sim/crew";

/** Ships only -- crew, hiring, and crew-fullness speed scaling are Ship-specific (see Captain.hireCrewIfPossible/crewSpeedFraction); every other Transport type has no crew composition worth listing here. */
export function TransportsPanel() {
  const world = useSimStore((s) => s.world);
  const killCrewMember = useSimStore((s) => s.killCrewMember);
  if (world === null) return null;

  const ships = world.captains
    .filter((captain) => captain.transport instanceof Ship)
    .map((captain) => captain.transport as Ship);

  return (
    <div className="panel transports-panel">
      <h2>Transports</h2>
      {ships.length === 0 ? (
        <p className="muted">No Ships in this World.</p>
      ) : (
        <dl className="transport-list">
          {ships.map((ship, i) => (
            // Ship names aren't guaranteed unique across the whole fleet, so
            // key by index -- same rationale as FleetPanel's captain rows.
            <div className="transport-entry" key={i}>
              <dt>
                {ship.name}
                <span className="muted">
                  {" "}
                  — {ship.crew.length}/{ship.crewRequirement} crew, {Math.round(crewSpeedFraction(ship) * 100)}% speed
                </span>
              </dt>
              <dd>
                <table className="transport-crew-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {ship.crew.map((member, j) => (
                      <tr key={j}>
                        <td>{member.name}</td>
                        <td>
                          {/* The Captain isn't hired/rehired the way a Sailor
                              is (see Faction.crewTransport/hireCrewIfPossible),
                              so only Sailors get a Kill button. */}
                          {member instanceof Sailor && (
                            <button
                              type="button"
                              disabled={ship.status !== "InTransit"}
                              onClick={() => killCrewMember(ship, member)}
                            >
                              Kill
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
