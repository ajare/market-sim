import { useSimStore } from "../state/useSimStore";
import { Ship, crewSpeedFraction } from "../sim/transport";

/** Ships only -- crew, hiring, and crew-fullness speed scaling are Ship-specific (see Captain.hireCrewIfPossible/crewSpeedFraction); every other Transport type has no crew composition worth listing here. */
export function TransportsPanel() {
  const world = useSimStore((s) => s.world);
  const killCrewMember = useSimStore((s) => s.killCrewMember);
  const selectedPerson = useSimStore((s) => s.selectedPerson);
  const selectPerson = useSimStore((s) => s.selectPerson);
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
                      <tr key={j} className={member === selectedPerson ? "fleet-row-selected" : undefined}>
                        <td>
                          <button type="button" className="link-button" onClick={() => selectPerson(member)}>
                            {member.name}
                          </button>
                        </td>
                        <td>
                          {/* The Captain isn't hired/rehired the way a plain
                              Sailor is (see Faction.crewFleet/
                              hireCrewIfPossible), so only Able Seamen get a
                              Kill button -- Captain extends Sailor now, so
                              `instanceof Sailor` alone would wrongly include
                              it too; rank is the actual discriminator. */}
                          {member.rank === "Able Seaman" && (
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
