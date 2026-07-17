/**
 * Lists the ExpeditionParties (exploration mode) in this World -- each an
 * Explorer/PorterParty pair starting at a home Location. Mirrors
 * CompaniesPanel's rollup-card pattern (cards start collapsed to a summary
 * row). Display/edit only -- an ExpeditionParty is created via CompaniesPanel's
 * unified "New Faction" section (Company vs Explorer Party), the same way
 * every Faction is created, not through a creation form of its own here.
 */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";

export function ExplorerPartiesPanel() {
  const explorers = useEditorStore((s) => s.explorers);
  const locations = useEditorStore((s) => s.locations);
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const updateExplorer = useEditorStore((s) => s.updateExplorer);
  const removeExplorer = useEditorStore((s) => s.removeExplorer);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Only entities that actually own a Location are offered -- mirrors
  // CompaniesPanel's affiliatableEntities (see companyHome.ts's doc comment
  // there for why: an entity with no Location can't provide anything an
  // affiliation would need).
  const affiliatableEntities = politicalEntities.filter((p) => locations.some((l) => l.politicalEntityId === p.id));

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="explorers-panel">
      <div className="sidebar-section-header">Explorer Parties</div>
      {explorers.length === 0 && (
        <div className="explorers-empty">No expedition parties defined yet -- add one via Companies' "New Faction" section.</div>
      )}
      <div className="rollup-list">
        {explorers.map((explorer) => {
          const expanded = expandedIds.has(explorer.id);
          const home = locations.find((l) => l.id === explorer.homeLocationId);
          const affiliation = politicalEntities.find((p) => p.id === explorer.politicalEntityId)?.name ?? "Independent";
          return (
            <div className="explorer-card" key={explorer.id}>
              <div className="explorer-card-header">
                <button
                  type="button"
                  className="rollup-toggle"
                  onClick={() => toggleExpanded(explorer.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <input
                  className="company-name-input"
                  value={explorer.name}
                  onChange={(e) => updateExplorer(explorer.id, { name: e.target.value })}
                />
                {!expanded && (
                  <span className="rollup-summary">
                    {affiliation} · {home?.name ?? "no home"} · {explorer.porterCount} porters · ${explorer.startingCash.toLocaleString()}
                  </span>
                )}
                <button type="button" onClick={() => removeExplorer(explorer.id)}>
                  &times;
                </button>
              </div>
              {expanded && (
                <>
                  <label className="company-field">
                    Political entity
                    <select
                      value={explorer.politicalEntityId ?? ""}
                      onChange={(e) =>
                        updateExplorer(explorer.id, { politicalEntityId: e.target.value === "" ? null : e.target.value })
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
                  <label className="company-field">
                    Home Location
                    {locations.length === 0 ? (
                      <div className="company-home-location-note">No Locations exist yet.</div>
                    ) : (
                      <select
                        value={explorer.homeLocationId}
                        onChange={(e) => updateExplorer(explorer.id, { homeLocationId: e.target.value })}
                      >
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                  <label className="company-field">
                    Porters
                    <input
                      type="number"
                      min={0}
                      value={explorer.porterCount}
                      onChange={(e) => updateExplorer(explorer.id, { porterCount: Number(e.target.value) })}
                    />
                  </label>
                  <label className="company-field">
                    Pack animals
                    <input
                      type="number"
                      min={0}
                      value={explorer.animalCount}
                      onChange={(e) => updateExplorer(explorer.id, { animalCount: Number(e.target.value) })}
                    />
                  </label>
                  <label className="company-field">
                    Starting cash
                    <input
                      type="number"
                      value={explorer.startingCash}
                      onChange={(e) => updateExplorer(explorer.id, { startingCash: Number(e.target.value) })}
                    />
                  </label>
                  <label className="terminal-type-checkbox">
                    <input
                      type="checkbox"
                      checked={explorer.aiControlled}
                      onChange={(e) => updateExplorer(explorer.id, { aiControlled: e.target.checked })}
                    />
                    AI-controlled (wanders/restocks on its own each day; unchecked means it only moves when a player picks its next leg)
                  </label>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
