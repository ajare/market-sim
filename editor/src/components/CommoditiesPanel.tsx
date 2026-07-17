/** Defines the global commodity registry -- name, base price, and base production/consumption rate -- that every Location's commodity dropdowns draw from. */
import { useState } from "react";
import { useEditorStore } from "../state/useEditorStore";
import { PRESET_COMMODITIES, COMMODITY_TYPES } from "../types";

export function CommoditiesPanel() {
  const commodities = useEditorStore((s) => s.commodities);
  const addCommodity = useEditorStore((s) => s.addCommodity);
  const updateCommodityBasePrice = useEditorStore((s) => s.updateCommodityBasePrice);
  const updateCommodityProductionRate = useEditorStore((s) => s.updateCommodityProductionRate);
  const updateCommodityConsumptionRate = useEditorStore((s) => s.updateCommodityConsumptionRate);
  const updateCommodityType = useEditorStore((s) => s.updateCommodityType);
  const updateCommodityGift = useEditorStore((s) => s.updateCommodityGift);
  const removeCommodity = useEditorStore((s) => s.removeCommodity);
  const [newName, setNewName] = useState("");
  const [expandedNames, setExpandedNames] = useState<Set<string>>(new Set());

  function toggleExpanded(name: string) {
    setExpandedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function handleAdd() {
    if (newName.trim() === "") return;
    addCommodity(newName);
    setNewName("");
  }

  // Picks a random trade good from the unified preset pool not already in
  // the registry and adds it with its suggested base price/type
  // (addCommodity is a no-op on a duplicate name, but filtering first keeps
  // the button useful once some are already added).
  function addRandomTradeGood() {
    const available = PRESET_COMMODITIES.filter((g) => !commodities.some((c) => c.name === g.name));
    if (available.length === 0) return;
    const good = available[Math.floor(Math.random() * available.length)];
    addCommodity(good.name, good.basePrice, good.type);
  }
  const availableTradeGoods = PRESET_COMMODITIES.filter(
    (g) => !commodities.some((c) => c.name === g.name),
  );

  return (
    <div className="commodities-panel">
      <div className="sidebar-section-header">Commodities</div>
      {commodities.length === 0 && <div className="commodities-empty">No commodities defined yet.</div>}
      <div className="rollup-list">
        {commodities.map((commodity) => {
          const expanded = expandedNames.has(commodity.name);
          return (
            <div className="commodity-card" key={commodity.name}>
              <div className="commodity-card-header">
                <button
                  type="button"
                  className="rollup-toggle"
                  onClick={() => toggleExpanded(commodity.name)}
                  aria-expanded={expanded}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <span className="commodity-name-label">{commodity.name}</span>
                {!expanded && (
                  <span className="rollup-summary">
                    {commodity.type} · ${commodity.basePrice.toLocaleString()}
                  </span>
                )}
                <button type="button" onClick={() => removeCommodity(commodity.name)}>
                  &times;
                </button>
              </div>
              {expanded && (
                <div className="commodity-card-fields">
                  <label className="commodity-field">
                    Type
                    <select
                      value={commodity.type}
                      onChange={(e) => updateCommodityType(commodity.name, e.target.value as typeof commodity.type)}
                    >
                      {COMMODITY_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  <label className="commodity-field">
                    Gift value
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={commodity.gift}
                      onChange={(e) => updateCommodityGift(commodity.name, Number(e.target.value))}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
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
      <button
        type="button"
        className="add-trade-good-button"
        title="Add a random trade good with a suitable base price"
        onClick={addRandomTradeGood}
        disabled={availableTradeGoods.length === 0}
      >
        🎲 add trade good
      </button>
    </div>
  );
}
