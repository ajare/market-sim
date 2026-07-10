import { useSimStore } from "../state/useSimStore";

export function CountriesPanel() {
  const countries = useSimStore((s) => s.countries);

  return (
    <div className="panel countries-panel">
      <h2>Countries</h2>
      {countries.length === 0 ? (
        <p className="muted">No countries yet.</p>
      ) : (
        <dl className="country-list">
          {countries.map((country) => (
            <div className="country-entry" key={country.name}>
              <dt>
                {country.name}
                <span className="muted">
                  {" "}
                  — ${country.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })} pooled cash
                </span>
              </dt>
              <dd>
                <table className="country-location-table">
                  <thead>
                    <tr>
                      <th>Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {country.locations.map((loc) => (
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
