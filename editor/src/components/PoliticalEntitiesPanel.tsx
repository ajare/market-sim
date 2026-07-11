/**
 * Defines the PoliticalEntities a Location can belong to, and which one new
 * Locations placed on the canvas are assigned to. A Location can't be
 * created until a PoliticalEntity exists and is selected here (see
 * useEditorStore.addLocation) -- reassigning an existing Location's
 * PoliticalEntity happens in LocationInspector instead. Cards start
 * collapsed to a summary row (rolled up) so a World with many
 * PoliticalEntities doesn't force the whole sidebar to scroll -- click a
 * card to expand its type selector and member-location list.
 */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";
import { POLITICAL_ENTITY_TYPES } from "../types";

export function PoliticalEntitiesPanel() {
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const locations = useEditorStore((s) => s.locations);
  const pendingPoliticalEntityId = useEditorStore((s) => s.pendingPoliticalEntityId);
  const addPoliticalEntity = useEditorStore((s) => s.addPoliticalEntity);
  const removePoliticalEntity = useEditorStore((s) => s.removePoliticalEntity);
  const setPendingPoliticalEntityId = useEditorStore((s) => s.setPendingPoliticalEntityId);
  const setPoliticalEntityType = useEditorStore((s) => s.setPoliticalEntityType);
  const updatePoliticalEntityName = useEditorStore((s) => s.updatePoliticalEntityName);
  const selectLocation = useEditorStore((s) => s.selectLocation);
  const [newName, setNewName] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function handleAdd() {
    if (newName.trim() === "") return;
    addPoliticalEntity(newName);
    setNewName("");
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
    <div className="political-entities-panel">
      <div className="sidebar-section-header">Political Entities</div>

      <label className="new-location-political-entity-label">
        New locations go to
        <select
          value={pendingPoliticalEntityId ?? ""}
          onChange={(e) => setPendingPoliticalEntityId(e.target.value === "" ? null : e.target.value)}
          disabled={politicalEntities.length === 0}
        >
          <option value="">
            {politicalEntities.length === 0 ? "no political entities defined" : "select political entity..."}
          </option>
          {politicalEntities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {politicalEntities.length === 0 && (
        <div className="political-entities-empty">No political entities defined yet.</div>
      )}

      <div className="rollup-list">
        {politicalEntities.map((politicalEntity) => {
          const members = locations.filter((loc) => loc.politicalEntityId === politicalEntity.id);
          const expanded = expandedIds.has(politicalEntity.id);
          return (
            <div className="political-entity-card" key={politicalEntity.id}>
              <div className="political-entity-card-header">
                <button
                  type="button"
                  className="rollup-toggle"
                  onClick={() => toggleExpanded(politicalEntity.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <input
                  className="political-entity-name-input"
                  value={politicalEntity.name}
                  onChange={(e) => updatePoliticalEntityName(politicalEntity.id, e.target.value)}
                />
                {!expanded && (
                  <span className="rollup-summary">
                    {politicalEntity.type} · {members.length} loc{members.length === 1 ? "" : "s"}
                  </span>
                )}
                <button type="button" onClick={() => removePoliticalEntity(politicalEntity.id)}>
                  &times;
                </button>
              </div>
              {expanded && (
                <>
                  <label className="political-entity-type-label">
                    Type
                    <select
                      value={politicalEntity.type}
                      onChange={(e) =>
                        setPoliticalEntityType(politicalEntity.id, e.target.value as typeof politicalEntity.type)
                      }
                    >
                      {POLITICAL_ENTITY_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  {members.length === 0 ? (
                    <div className="political-entity-locations-empty">No locations yet.</div>
                  ) : (
                    <ul className="political-entity-locations">
                      {members.map((loc) => (
                        <li key={loc.id}>
                          <button type="button" onClick={() => selectLocation(loc.id)}>
                            {loc.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="commodity-row commodity-row-new">
        <input
          className="commodity-name"
          placeholder="new political entity"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button type="button" onClick={handleAdd}>
          + add
        </button>
      </div>
    </div>
  );
}
