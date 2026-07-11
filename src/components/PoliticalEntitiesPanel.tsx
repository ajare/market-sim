import { useSimStore } from "../state/useSimStore";

export function PoliticalEntitiesPanel() {
  const politicalEntities = useSimStore((s) => s.politicalEntities);

  return (
    <div className="panel political-entities-panel">
      <h2>Political Entities</h2>
      {politicalEntities.length === 0 ? (
        <p className="muted">No political entities yet.</p>
      ) : (
        <dl className="political-entity-list">
          {politicalEntities.map((politicalEntity) => (
            <div className="political-entity-entry" key={politicalEntity.name}>
              <dt>
                {politicalEntity.name}
                <span className="muted">
                  {" "}
                  — ${politicalEntity.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })} pooled cash
                </span>
              </dt>
              <dd>
                <table className="political-entity-location-table">
                  <thead>
                    <tr>
                      <th>Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {politicalEntity.locations.map((loc) => (
                      <tr key={loc.name}>
                        <td>{loc.name}</td>
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
