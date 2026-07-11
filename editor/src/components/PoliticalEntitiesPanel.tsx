/**
 * Defines the PoliticalEntities a Location can belong to, and which one new
 * Locations placed on the canvas are assigned to. A Location can't be
 * created until a PoliticalEntity exists and is selected here (see
 * useEditorStore.addLocation) -- reassigning an existing Location's
 * PoliticalEntity happens in LocationInspector instead.
 */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";

export function PoliticalEntitiesPanel() {
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const locations = useEditorStore((s) => s.locations);
  const pendingPoliticalEntityId = useEditorStore((s) => s.pendingPoliticalEntityId);
  const addPoliticalEntity = useEditorStore((s) => s.addPoliticalEntity);
  const removePoliticalEntity = useEditorStore((s) => s.removePoliticalEntity);
  const setPendingPoliticalEntityId = useEditorStore((s) => s.setPendingPoliticalEntityId);
  const selectLocation = useEditorStore((s) => s.selectLocation);
  const [newName, setNewName] = useState("");

  function handleAdd() {
    if (newName.trim() === "") return;
    addPoliticalEntity(newName);
    setNewName("");
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

      {politicalEntities.map((politicalEntity) => {
        const members = locations.filter((loc) => loc.politicalEntityId === politicalEntity.id);
        return (
          <div className="political-entity-card" key={politicalEntity.id}>
            <div className="political-entity-card-header">
              <span className="political-entity-name-label">{politicalEntity.name}</span>
              <button type="button" onClick={() => removePoliticalEntity(politicalEntity.id)}>
                &times;
              </button>
            </div>
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
          </div>
        );
      })}

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
