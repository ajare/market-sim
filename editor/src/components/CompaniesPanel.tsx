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
  type EditorLocation, type TransportType,
} from "../types";
import {
  NATIONALITIES, generateCaptainName, generateCompanyName, generateShipName, type Nationality,
} from "../nameGenerators";
import { locationSupportsFleet, locationSupportsTransportType } from "../companyHome";

function randomFamousName(): string {
  return FAMOUS_HISTORICAL_NAMES[Math.floor(Math.random() * FAMOUS_HISTORICAL_NAMES.length)];
}

/** `homeLocation` is null for a SoloTrader (no home Location to constrain against yet) or a real Company that hasn't resolved one -- either way every TransportType is offered. */
function FleetMemberForm({ companyId, homeLocation }: { companyId: string; homeLocation: EditorLocation | null }) {
  const addFleetMember = useEditorStore((s) => s.addFleetMember);
  const availableTypes =
    homeLocation !== null ? TRANSPORT_TYPES.filter((t) => locationSupportsTransportType(homeLocation, t)) : TRANSPORT_TYPES;
  const [transportType, setTransportType] = useState<TransportType>(availableTypes[0] ?? "Ship");
  const [transportName, setTransportName] = useState("");
  const [captainName, setCaptainName] = useState("");

  function handleAdd() {
    if (transportName.trim() === "" || captainName.trim() === "") return;
    addFleetMember(companyId, transportType, transportName, captainName);
    setTransportName("");
    setCaptainName("");
  }

  if (availableTypes.length === 0) {
    return (
      <div className="fleet-member-form fleet-member-form-blocked">
        This Company's home Location doesn't support any Transport type -- give it a TerminalType first.
      </div>
    );
  }

  return (
    <div className="fleet-member-form">
      <label className="fleet-member-field">
        Transport type
        <select
          value={availableTypes.includes(transportType) ? transportType : availableTypes[0]}
          onChange={(e) => setTransportType(e.target.value as TransportType)}
        >
          {availableTypes.map((t) => (
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
  const locations = useEditorStore((s) => s.locations);
  const addGeneratedCompany = useEditorStore((s) => s.addGeneratedCompany);
  const addExplorer = useEditorStore((s) => s.addExplorer);
  const updateCompanyName = useEditorStore((s) => s.updateCompanyName);
  const updateCompanyStartingFunds = useEditorStore((s) => s.updateCompanyStartingFunds);
  const updateCompanyPoliticalEntity = useEditorStore((s) => s.updateCompanyPoliticalEntity);
  const updateCompanyHomeLocation = useEditorStore((s) => s.updateCompanyHomeLocation);
  const removeCompany = useEditorStore((s) => s.removeCompany);
  const removeFleetMember = useEditorStore((s) => s.removeFleetMember);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // A new Faction is either a Company or an ExplorerParty -- ExpeditionParty
  // is just another kind of Faction (see src/sim/faction.ts), not a separate
  // creation flow, so both share this one "New Faction" section with the
  // same field set (Nationality, Captains, Captain name(s), Political
  // entity, Home Location) rather than each having its own bespoke form --
  // an ExplorerParty is simply pinned to exactly 1 captain (the Explorer).
  const [newFactionType, setNewFactionType] = useState<"Company" | "ExplorerParty">("Company");
  const [nationality, setNationality] = useState<Nationality>("English");
  const [numCaptains, setNumCaptains] = useState(3);
  const [captainNames, setCaptainNames] = useState<string[]>(["", "", ""]);
  const [explorerName, setExplorerName] = useState("");
  const [politicalEntityId, setPoliticalEntityId] = useState("");
  const [homeLocationId, setHomeLocationId] = useState("");

  // Only entities that actually own a Location are offered -- an entity with
  // none can't provide a default home Location, so affiliating with it would
  // be a dead end (see companyHome.ts).
  const affiliatableEntities = politicalEntities.filter((p) => locations.some((l) => l.politicalEntityId === p.id));

  // A 1-captain Company is a SoloTrader outright (see faction.ts) -- it has
  // no home Location at all, unlike a 1-captain ExplorerParty (whose single
  // Explorer always starts at a real home Location).
  const isSoloTrader = newFactionType === "Company" && numCaptains === 1;
  // Every generated Company fleet member is a Ship, so its candidate home
  // Locations are filtered the same way defaultCompanyHomeLocation filters
  // them; an ExplorerParty's home Location has no such Route/TerminalType
  // constraint (a PorterParty travels overland via Trail routes).
  const homeLocationOptions =
    newFactionType === "Company" ? locations.filter((l) => locationSupportsTransportType(l, "Ship")) : locations;
  const effectiveHomeLocationId =
    homeLocationId !== "" && homeLocationOptions.some((l) => l.id === homeLocationId)
      ? homeLocationId
      : (homeLocationOptions[0]?.id ?? "");

  const namesFilled =
    newFactionType === "Company"
      ? numCaptains === 0 || captainNames.every((n) => n.trim() !== "")
      : explorerName.trim() !== "";
  const needsHomeLocation = !isSoloTrader;
  const canSubmit = locations.length > 0 && namesFilled && (!needsHomeLocation || effectiveHomeLocationId !== "");

  function handleNumCaptainsChange(raw: number) {
    const count = Math.max(0, Math.floor(raw));
    setNumCaptains(count);
    setCaptainNames((prev) => {
      const next = prev.slice(0, count);
      while (next.length < count) next.push("");
      return next;
    });
  }

  function setCaptainNameAt(index: number, value: string) {
    setCaptainNames((prev) => prev.map((n, i) => (i === index ? value : n)));
  }

  // Builds a whole Company at once from the chosen nationality/captain names:
  // a generated company name plus one fleet member per captain name, each
  // with a generated (Ship) ship name (see nameGenerators) -- only the
  // captain names themselves are authored (manually, or via each name's own
  // dice button), same as ExplorerParty's single name below.
  function handleAddCompany() {
    if (!canSubmit) return;
    const members = captainNames.map((name) => ({
      transportType: "Ship" as TransportType,
      transportName: generateShipName(nationality),
      captainName: name.trim(),
    }));
    addGeneratedCompany(
      generateCompanyName(nationality),
      members,
      DEFAULT_COMPANY_STARTING_FUNDS,
      politicalEntityId === "" ? null : politicalEntityId,
      isSoloTrader ? null : effectiveHomeLocationId,
    );
    setCaptainNames(Array.from({ length: numCaptains }, () => ""));
  }

  function handleAddExplorer() {
    if (!canSubmit) return;
    addExplorer(explorerName, effectiveHomeLocationId, politicalEntityId === "" ? null : politicalEntityId);
    setExplorerName("");
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
      <div className="company-generator">
        <div className="field-label">New Faction</div>
        <div className="faction-type-toggle">
          <label>
            <input
              type="radio"
              name="new-faction-type"
              checked={newFactionType === "Company"}
              onChange={() => setNewFactionType("Company")}
            />
            Company
          </label>
          <label>
            <input
              type="radio"
              name="new-faction-type"
              checked={newFactionType === "ExplorerParty"}
              onChange={() => setNewFactionType("ExplorerParty")}
            />
            Explorer Party
          </label>
        </div>
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
              min={newFactionType === "ExplorerParty" ? 1 : 0}
              max={50}
              value={newFactionType === "ExplorerParty" ? 1 : numCaptains}
              disabled={newFactionType === "ExplorerParty"}
              onChange={(e) => handleNumCaptainsChange(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="fleet-captain-name-list">
          {newFactionType === "Company" ? (
            captainNames.map((name, i) => (
              <label key={i} className="company-generator-field">
                {captainNames.length > 1 ? `Captain ${i + 1} name` : "Captain name"}
                <div className="fleet-captain-name-row">
                  <input value={name} onChange={(e) => setCaptainNameAt(i, e.target.value)} />
                  <button type="button" title="Random name" onClick={() => setCaptainNameAt(i, generateCaptainName(nationality))}>
                    🎲
                  </button>
                </div>
              </label>
            ))
          ) : (
            <label className="company-generator-field">
              Name
              <div className="fleet-captain-name-row">
                <input value={explorerName} onChange={(e) => setExplorerName(e.target.value)} />
                <button type="button" title="Random name" onClick={() => setExplorerName(generateCaptainName(nationality))}>
                  🎲
                </button>
              </div>
            </label>
          )}
        </div>
        <label className="company-generator-field">
          Political entity
          <select value={politicalEntityId} onChange={(e) => setPoliticalEntityId(e.target.value)}>
            <option value="">Independent</option>
            {affiliatableEntities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {isSoloTrader ? (
          <div className="company-generator-field company-home-location-note">
            SoloTraders have no home Location -- their one ship starts somewhere random.
          </div>
        ) : (
          <label className="company-generator-field">
            Home Location
            <select value={effectiveHomeLocationId} onChange={(e) => setHomeLocationId(e.target.value)}>
              {homeLocationOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="company-generator-button"
          onClick={newFactionType === "Company" ? handleAddCompany : handleAddExplorer}
          disabled={!canSubmit}
          title={
            locations.length === 0
              ? `Place a Location first -- a ${newFactionType === "Company" ? "Company" : "Explorer Party"} needs a home Location.`
              : undefined
          }
        >
          {newFactionType === "Company" ? "+ add company" : "+ add explorer party"}
        </button>
      </div>
      <div className="sidebar-section-header">Companies</div>
      {companies.length === 0 && <div className="companies-empty">No companies defined yet.</div>}
      <div className="rollup-list">
        {companies.map((company) => {
          const expanded = expandedIds.has(company.id);
          const faction = factionType(company.fleet);
          const affiliation =
            politicalEntities.find((p) => p.id === company.politicalEntityId)?.name ?? "Independent";
          const homeLocation = locations.find((l) => l.id === company.homeLocationId) ?? null;
          // A SoloTrader has no home Location at all; a real Company's
          // dropdown only offers Locations compatible with its current fleet
          // (see companyHome.ts) -- never one that would throw when the
          // World is built.
          const homeLocationOptions =
            faction === "SoloTrader"
              ? []
              : locations.filter((l) => locationSupportsFleet(l, company.fleet.map((m) => m.transportType)));
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
                      {affiliatableEntities.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  {faction === "SoloTrader" ? (
                    <div className="company-field company-home-location-note">
                      SoloTraders have no home Location -- their one ship starts somewhere random.
                    </div>
                  ) : (
                    <label className="company-field">
                      Home Location
                      {homeLocationOptions.length === 0 ? (
                        <div className="company-home-location-note">
                          No Location supports this fleet's Transport types yet.
                        </div>
                      ) : (
                        <select
                          value={company.homeLocationId ?? ""}
                          onChange={(e) => updateCompanyHomeLocation(company.id, e.target.value)}
                        >
                          {company.homeLocationId === null && <option value="">-- choose a home Location --</option>}
                          {homeLocationOptions.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                  )}

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
                    <FleetMemberForm companyId={company.id} homeLocation={homeLocation} />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
