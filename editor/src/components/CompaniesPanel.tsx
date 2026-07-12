/**
 * Defines the Companies in this World -- name, starting funds, and a fleet
 * of Captain/Transport pairs. Cards start collapsed to a summary row
 * (rolled up) so a World with many Companies doesn't force the whole
 * sidebar to scroll -- click a card to expand its starting funds field and
 * fleet editor.
 */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";
import {
  DEFAULT_COMPANY_STARTING_FUNDS, FAMOUS_HISTORICAL_NAMES, factionType, TRANSPORT_TYPES, TRANSPORT_TYPE_LABELS,
  type TransportType,
} from "../types";
import {
  NATIONALITIES, generateCaptainName, generateCompanyName, generateShipName, type Nationality,
} from "../nameGenerators";

function randomFamousName(): string {
  return FAMOUS_HISTORICAL_NAMES[Math.floor(Math.random() * FAMOUS_HISTORICAL_NAMES.length)];
}

function FleetMemberForm({ companyId }: { companyId: string }) {
  const addFleetMember = useEditorStore((s) => s.addFleetMember);
  const [transportType, setTransportType] = useState<TransportType>("Ship");
  const [transportName, setTransportName] = useState("");
  const [captainName, setCaptainName] = useState("");

  function handleAdd() {
    if (transportName.trim() === "" || captainName.trim() === "") return;
    addFleetMember(companyId, transportType, transportName, captainName);
    setTransportName("");
    setCaptainName("");
  }

  return (
    <div className="fleet-member-form">
      <label className="fleet-member-field">
        Transport type
        <select value={transportType} onChange={(e) => setTransportType(e.target.value as TransportType)}>
          {TRANSPORT_TYPES.map((t) => (
            <option key={t} value={t}>
              {TRANSPORT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="fleet-member-field">
        Transport name
        <input value={transportName} onChange={(e) => setTransportName(e.target.value)} />
      </label>
      <label className="fleet-member-field">
        Captain name
        <div className="fleet-captain-name-row">
          <input value={captainName} onChange={(e) => setCaptainName(e.target.value)} />
          <button type="button" title="Random name" onClick={() => setCaptainName(randomFamousName())}>
            🎲
          </button>
        </div>
      </label>
      <button type="button" onClick={handleAdd}>
        + add to fleet
      </button>
    </div>
  );
}

export function CompaniesPanel() {
  const companies = useEditorStore((s) => s.companies);
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const addGeneratedCompany = useEditorStore((s) => s.addGeneratedCompany);
  const updateCompanyName = useEditorStore((s) => s.updateCompanyName);
  const updateCompanyStartingFunds = useEditorStore((s) => s.updateCompanyStartingFunds);
  const updateCompanyPoliticalEntity = useEditorStore((s) => s.updateCompanyPoliticalEntity);
  const removeCompany = useEditorStore((s) => s.removeCompany);
  const removeFleetMember = useEditorStore((s) => s.removeFleetMember);
  const [nationality, setNationality] = useState<Nationality>("English");
  const [numCaptains, setNumCaptains] = useState(3);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Builds a whole Company at once from the chosen nationality: a generated
  // company name plus `numCaptains` fleet members, each with a generated
  // captain name and (Ship) ship name (see nameGenerators).
  function handleGenerate() {
    const count = Math.max(0, Math.floor(numCaptains));
    const members = Array.from({ length: count }, () => ({
      transportType: "Ship" as TransportType,
      transportName: generateShipName(nationality),
      captainName: generateCaptainName(nationality),
    }));
    addGeneratedCompany(generateCompanyName(nationality), members, DEFAULT_COMPANY_STARTING_FUNDS);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="companies-panel">
      <div className="sidebar-section-header">Companies</div>
      {companies.length === 0 && <div className="companies-empty">No companies defined yet.</div>}
      <div className="rollup-list">
        {companies.map((company) => {
          const expanded = expandedIds.has(company.id);
          const faction = factionType(company.fleet);
          const affiliation =
            politicalEntities.find((p) => p.id === company.politicalEntityId)?.name ?? "Independent";
          return (
            <div className="company-card" key={company.id}>
              <div className="company-card-header">
                <button
                  type="button"
                  className="rollup-toggle"
                  onClick={() => toggleExpanded(company.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <input
                  className="company-name-input"
                  value={company.name}
                  onChange={(e) => updateCompanyName(company.id, e.target.value)}
                />
                {!expanded && (
                  <span className="rollup-summary">
                    {affiliation} · {faction} · ${company.startingFunds.toLocaleString()} · {company.fleet.length} ship{company.fleet.length === 1 ? "" : "s"}
                  </span>
                )}
                <button type="button" onClick={() => removeCompany(company.id)}>
                  &times;
                </button>
              </div>
              {expanded && (
                <>
                  <div className="company-faction-type">
                    Faction type: <span className="company-faction-type-value">{faction}</span>
                  </div>
                  <label className="company-field">
                    Starting funds
                    <input
                      type="number"
                      value={company.startingFunds}
                      onChange={(e) => updateCompanyStartingFunds(company.id, Number(e.target.value))}
                    />
                  </label>

                  <label className="company-field">
                    Political entity
                    <select
                      value={company.politicalEntityId ?? ""}
                      onChange={(e) =>
                        updateCompanyPoliticalEntity(company.id, e.target.value === "" ? null : e.target.value)
                      }
                    >
                      <option value="">Independent</option>
                      {politicalEntities.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="fleet-section">
                    <div className="fleet-section-header">Fleet</div>
                    {company.fleet.length === 0 ? (
                      <div className="fleet-empty">No Captains or Transports yet.</div>
                    ) : (
                      <ul className="fleet-list">
                        {company.fleet.map((member) => (
                          <li key={member.id} className="fleet-list-item">
                            <span className="fleet-member-summary">
                              {member.captainName} -- {member.transportName} ({TRANSPORT_TYPE_LABELS[member.transportType]})
                            </span>
                            <button type="button" onClick={() => removeFleetMember(company.id, member.id)}>
                              &times;
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <FleetMemberForm companyId={company.id} />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="company-generator">
        <div className="field-label">New company</div>
        <div className="company-generator-fields">
          <label className="company-generator-field">
            Nationality
            <select value={nationality} onChange={(e) => setNationality(e.target.value as Nationality)}>
              {NATIONALITIES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="company-generator-field">
            Captains
            <input
              type="number"
              min={0}
              max={50}
              value={numCaptains}
              onChange={(e) => setNumCaptains(Number(e.target.value))}
            />
          </label>
        </div>
        <button type="button" className="company-generator-button" onClick={handleGenerate}>
          🎲 Generate company
        </button>
      </div>
    </div>
  );
}
