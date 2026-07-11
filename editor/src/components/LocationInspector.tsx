/** Edit form for the currently selected Location -- name, position, terminal types, and commodity maps. */
import { useEditorStore } from "../state/useEditorStore";
import { TERMINAL_TYPES } from "../types";
import { CommodityMapEditor } from "./CommodityMapEditor";

export function LocationInspector() {
  const selectedId = useEditorStore((s) => s.selectedId);
  const location = useEditorStore((s) => s.locations.find((l) => l.id === s.selectedId));
  const updateLocation = useEditorStore((s) => s.updateLocation);
  const toggleTerminalType = useEditorStore((s) => s.toggleTerminalType);
  const removeLocation = useEditorStore((s) => s.removeLocation);

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
          x
          <input
            type="number"
            value={location.x}
            onChange={(e) => updateLocation(location.id, { x: Number(e.target.value) })}
          />
        </label>
        <label>
          y
          <input
            type="number"
            value={location.y}
            onChange={(e) => updateLocation(location.id, { y: Number(e.target.value) })}
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
