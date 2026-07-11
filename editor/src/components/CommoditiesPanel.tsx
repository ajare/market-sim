/** Defines the global commodity registry -- name, base price, and base production/consumption rate -- that every Location's commodity dropdowns draw from. */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";

export function CommoditiesPanel() {
  const commodities = useEditorStore((s) => s.commodities);
  const addCommodity = useEditorStore((s) => s.addCommodity);
  const updateCommodityBasePrice = useEditorStore((s) => s.updateCommodityBasePrice);
  const updateCommodityProductionRate = useEditorStore((s) => s.updateCommodityProductionRate);
  const updateCommodityConsumptionRate = useEditorStore((s) => s.updateCommodityConsumptionRate);
  const removeCommodity = useEditorStore((s) => s.removeCommodity);
  const [newName, setNewName] = useState("");

  function handleAdd() {
    if (newName.trim() === "") return;
    addCommodity(newName);
    setNewName("");
  }

  return (
    <div className="commodities-panel">
      <div className="sidebar-section-header">Commodities</div>
      {commodities.length === 0 && <div className="commodities-empty">No commodities defined yet.</div>}
      {commodities.map((commodity) => (
        <div className="commodity-card" key={commodity.name}>
          <div className="commodity-card-header">
            <span className="commodity-name-label">{commodity.name}</span>
            <button type="button" onClick={() => removeCommodity(commodity.name)}>
              &times;
            </button>
          </div>
          <div className="commodity-card-fields">
            <label className="commodity-field">
              Base price
              <input
                type="number"
                value={commodity.basePrice}
                onChange={(e) => updateCommodityBasePrice(commodity.name, Number(e.target.value))}
              />
            </label>
            <label className="commodity-field">
              Production rate
              <input
                type="number"
                value={commodity.productionRate}
                onChange={(e) => updateCommodityProductionRate(commodity.name, Number(e.target.value))}
              />
            </label>
            <label className="commodity-field">
              Consumption rate
              <input
                type="number"
                value={commodity.consumptionRate}
                onChange={(e) => updateCommodityConsumptionRate(commodity.name, Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      ))}
      <div className="commodity-row commodity-row-new">
        <input
          className="commodity-name"
          placeholder="new commodity"
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
