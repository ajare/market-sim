/** Edit form for the currently selected Location -- name, position, terminal types, and commodity maps. */
import { useEditorStore } from "../state/useEditorStore";
import { TERMINAL_TYPES } from "../types";
import { CommodityMapEditor } from "./CommodityMapEditor";
import { LocationRoutesTable } from "./LocationRoutesTable";

export function LocationInspector() {
  const selectedId = useEditorStore((s) => s.selectedId);
  const location = useEditorStore((s) => s.locations.find((l) => l.id === s.selectedId));
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const updateLocation = useEditorStore((s) => s.updateLocation);
  const toggleTerminalType = useEditorStore((s) => s.toggleTerminalType);
  const removeLocation = useEditorStore((s) => s.removeLocation);
  const worldScale = useEditorStore((s) => s.worldScale);

  if (selectedId === null || location === undefined) {
    return (
      <div className="inspector inspector-empty">
        Click anywhere on the map to place a Location, or select an existing one to edit it.
      </div>
    );
  }

  return (
    <div className="inspector">
      <div className="inspector-header">
        <input
          className="location-name-input"
          value={location.name}
          onChange={(e) => updateLocation(location.id, { name: e.target.value })}
        />
        <button type="button" className="delete-button" onClick={() => removeLocation(location.id)}>
          Delete
        </button>
      </div>

      <div className="field-row">
        <label>
          Political entity
          <select
            value={location.politicalEntityId}
            onChange={(e) => updateLocation(location.id, { politicalEntityId: e.target.value })}
          >
            {politicalEntities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          x
          <input
            type="number"
            value={Math.round(location.x * worldScale * 100) / 100}
            onChange={(e) => updateLocation(location.id, { x: Number(e.target.value) / worldScale })}
          />
        </label>
        <label>
          y
          <input
            type="number"
            value={Math.round(location.y * worldScale * 100) / 100}
            onChange={(e) => updateLocation(location.id, { y: Number(e.target.value) / worldScale })}
          />
        </label>
        <label>
          fuel price
          <input
            type="number"
            value={location.fuelPrice}
            onChange={(e) => updateLocation(location.id, { fuelPrice: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="field-label">Terminal types</div>
      <div className="terminal-types">
        {TERMINAL_TYPES.map((terminal) => (
          <label key={terminal} className="terminal-type-checkbox">
            <input
              type="checkbox"
              checked={location.terminalTypes.includes(terminal)}
              onChange={() => toggleTerminalType(location.id, terminal)}
            />
            {terminal}
          </label>
        ))}
      </div>

      <LocationRoutesTable locationId={location.id} />

      <CommodityMapEditor
        locationId={location.id}
        field="producedCommodities"
        label="Produced commodities"
        rateLabel="Production ×"
        values={location.producedCommodities}
        basePriceModifiers={location.basePriceModifiers}
        otherRoleValues={location.consumedCommodities}
      />
      <CommodityMapEditor
        locationId={location.id}
        field="consumedCommodities"
        label="Consumed commodities"
        rateLabel="Consumption ×"
        values={location.consumedCommodities}
        basePriceModifiers={location.basePriceModifiers}
        otherRoleValues={location.producedCommodities}
      />
    </div>
  );
}
