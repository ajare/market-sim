/**
 * Table of a Location's producedCommodities/consumedCommodities -- one row
 * per commodity, with its rate modifier, base price modifier, and a delete
 * button. New rows are added by picking from the globally defined
 * Commodities; adding/removing/editing a rate here also keeps stockpiles in
 * sync (see the store) -- base price modifiers live alongside but are set
 * independently per row.
 */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";

export function CommodityMapEditor({
  locationId,
  field,
  label,
  rateLabel,
  values,
  basePriceModifiers,
  otherRoleValues,
}: {
  locationId: string;
  field: "producedCommodities" | "consumedCommodities";
  label: string;
  rateLabel: string;
  values: Record<string, number>;
  basePriceModifiers: Record<string, number>;
  /** The sibling field's commodities (produced's consumed, or vice versa) -- excluded from this dropdown so a commodity can never end up both produced and consumed at the same Location. */
  otherRoleValues: Record<string, number>;
}) {
  const commodities = useEditorStore((s) => s.commodities);
  const setCommodityValue = useEditorStore((s) => s.setCommodityValue);
  const addProducedCommodity = useEditorStore((s) => s.addProducedCommodity);
  const addConsumedCommodity = useEditorStore((s) => s.addConsumedCommodity);
  const removeProducedCommodity = useEditorStore((s) => s.removeProducedCommodity);
  const removeConsumedCommodity = useEditorStore((s) => s.removeConsumedCommodity);
  const [pendingCommodity, setPendingCommodity] = useState("");

  const entries = Object.entries(values);
  const available = commodities.filter((c) => !(c.name in values) && !(c.name in otherRoleValues));
  const addCommodity = field === "producedCommodities" ? addProducedCommodity : addConsumedCommodity;
  const removeCommodity = field === "producedCommodities" ? removeProducedCommodity : removeConsumedCommodity;

  function handleAdd() {
    if (pendingCommodity === "") return;
    addCommodity(locationId, pendingCommodity);
    setPendingCommodity("");
  }

  // Picks 1-3 random commodities from those not yet used at this Location and
  // adds them with their default (1.0) rate modifier -- a quick way to seed a
  // Location's commodities. `available` already excludes the sibling field's
  // commodities (otherRoleValues), so a randomly-consumed commodity can never
  // collide with a produced one and vice versa.
  function handleRandomize() {
    if (available.length === 0) return;
    const count = Math.min(available.length, 1 + Math.floor(Math.random() * 3));
    const pool = [...available];
    for (let i = 0; i < count; i++) {
      const pick = Math.floor(Math.random() * pool.length);
      addCommodity(locationId, pool[pick].name);
      pool.splice(pick, 1);
    }
  }

  return (
    <div className="commodity-table-section">
      <div className="field-label-row">
        <div className="field-label">{label}</div>
        <button
          type="button"
          className="random-name-button"
          title={`Generate 1-3 random ${field === "producedCommodities" ? "produced" : "consumed"} commodities with default values`}
          onClick={handleRandomize}
          disabled={available.length === 0}
        >
          🎲
        </button>
      </div>
      {entries.length > 0 && (
        <table className="commodity-table">
          <thead>
            <tr>
              <th>Commodity</th>
              <th>{rateLabel}</th>
              <th>Base price ×</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map(([commodity, value]) => (
              <tr key={commodity}>
                <td className="commodity-name-cell">{commodity}</td>
                <td>
                  <input
                    className="commodity-value"
                    type="number"
                    step={0.1}
                    value={value}
                    onChange={(e) => addCommodity(locationId, commodity, Number(e.target.value))}
                    title="Rate modifier -- multiplies the commodity's registered rate"
                  />
                </td>
                <td>
                  <input
                    className="commodity-value"
                    type="number"
                    step={0.1}
                    value={basePriceModifiers[commodity] ?? 1}
                    onChange={(e) =>
                      setCommodityValue(locationId, "basePriceModifiers", commodity, Number(e.target.value))
                    }
                    title="Rate modifier -- multiplies the commodity's registered base price"
                  />
                </td>
                <td>
                  <button type="button" onClick={() => removeCommodity(locationId, commodity)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="commodity-row commodity-row-new">
        <select
          value={pendingCommodity}
          onChange={(e) => setPendingCommodity(e.target.value)}
          disabled={available.length === 0}
        >
          <option value="">
            {commodities.length === 0
              ? "no commodities defined"
              : available.length === 0
                ? "all commodities in use"
                : "select commodity..."}
          </option>
          {available.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleAdd} disabled={pendingCommodity === ""}>
          + add
        </button>
      </div>
    </div>
  );
}
