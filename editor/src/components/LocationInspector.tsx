/** Edit form for the currently selected Location -- name, position, terminal types, and commodity maps. */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";
import { TERMINAL_TYPES, SETTLEMENT_TYPES } from "../types";
import { NATIONALITIES, generateLocationName, type Nationality } from "../nameGenerators";
import { CommodityMapEditor } from "./CommodityMapEditor";
import { LocationRoutesTable } from "./LocationRoutesTable";

export function LocationInspector() {
  const [nationality, setNationality] = useState<Nationality>("English");
  const selectedId = useEditorStore((s) => s.selectedId);
  const locations = useEditorStore((s) => s.locations);
  const location = locations.find((l) => l.id === selectedId);
  // Derived in the render body rather than as a store selector: a selector
  // returning a fresh array every call never settles to a stable snapshot,
  // which sends useSyncExternalStore (what Zustand's hook is built on) into
  // an infinite re-render loop ("Maximum update depth exceeded").
  const otherLocationNames = locations.filter((l) => l.id !== selectedId).map((l) => l.name);
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const commodities = useEditorStore((s) => s.commodities);
  const updateLocation = useEditorStore((s) => s.updateLocation);
  const toggleTerminalType = useEditorStore((s) => s.toggleTerminalType);
  const removeLocation = useEditorStore((s) => s.removeLocation);
  const worldScale = useEditorStore((s) => s.worldScale);
  const setLocationHasRuler = useEditorStore((s) => s.setLocationHasRuler);
  const updateLocationRuler = useEditorStore((s) => s.updateLocationRuler);
  const toggleRulerGiftCategory = useEditorStore((s) => s.toggleRulerGiftCategory);

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
        <div className="inspector-header-actions">
          <select
            className="random-name-nationality"
            value={nationality}
            title="Nationality for the generated colonial name"
            onChange={(e) => setNationality(e.target.value as Nationality)}
          >
            {NATIONALITIES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="random-name-button"
            title={`Generate a random ${nationality} colonial name`}
            onClick={() => {
              try {
                updateLocation(location.id, { name: generateLocationName(nationality, otherLocationNames) });
              } catch (err) {
                window.alert(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            🎲
          </button>
          <button type="button" className="delete-button" onClick={() => removeLocation(location.id)}>
            Delete
          </button>
        </div>
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
          Settlement type
          <select
            value={location.settlementType}
            onChange={(e) => updateLocation(location.id, { settlementType: e.target.value as typeof location.settlementType })}
          >
            {SETTLEMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
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

      <div className="field-label-row">
        <div className="field-label">Ruler (exploration mode)</div>
        <label className="terminal-type-checkbox">
          <input
            type="checkbox"
            checked={location.ruler !== null}
            onChange={(e) => setLocationHasRuler(location.id, e.target.checked)}
          />
          Has a personal ruler
        </label>
      </div>
      {location.ruler !== null && (
        <div className="ruler-section">
          <div className="field-row">
            <label>
              Name
              <input
                value={location.ruler.name}
                onChange={(e) => updateLocationRuler(location.id, { name: e.target.value })}
              />
            </label>
            <label>
              Passage tax %
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(location.ruler.passageTaxRate * 100)}
                onChange={(e) => updateLocationRuler(location.id, { passageTaxRate: Number(e.target.value) / 100 })}
              />
            </label>
            <label>
              Trust
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={location.ruler.trust}
                onChange={(e) => updateLocationRuler(location.id, { trust: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="field-label">Accepts as gift</div>
          {commodities.length === 0 ? (
            <div className="routes-empty">No commodities defined yet.</div>
          ) : (
            <div className="terminal-types">
              {commodities.map((c) => (
                <label key={c.name} className="terminal-type-checkbox">
                  <input
                    type="checkbox"
                    checked={location.ruler!.giftCategories.includes(c.name)}
                    onChange={() => toggleRulerGiftCategory(location.id, c.name)}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

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
