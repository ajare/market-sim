import { useEffect, useState } from "react";
import { useSimStore } from "../state/useSimStore";

/**
 * Exploration-mode panel: lists every Explorer in the World (mirrors
 * FleetPanel's list-plus-detail layout) and, for the selected one, shows
 * cash/inventory plus a Buy/Sell mini-form against the current Location's
 * Markets (mirrors BuyShipPanel's form pattern) and a "Choose next leg"
 * action. No dedicated screen -- just another panel alongside the existing
 * ones, per doc/ExploreGameIntegration.md's "No dedicated UI view" decision.
 */
export function ExplorerPanel() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const selectedExplorer = useSimStore((s) => s.selectedExplorer);
  const selectExplorer = useSimStore((s) => s.selectExplorer);
  const buyAtVillage = useSimStore((s) => s.buyAtVillage);
  const sellAtVillage = useSimStore((s) => s.sellAtVillage);
  const openLegChoice = useSimStore((s) => s.openLegChoice);

  const [buyCommodity, setBuyCommodity] = useState("");
  const [buyQuantity, setBuyQuantity] = useState(1);
  const [sellCommodity, setSellCommodity] = useState("");
  const [sellQuantity, setSellQuantity] = useState(1);
  const [message, setMessage] = useState<string | null>(null);

  const location = selectedExplorer?.porterParty.location ?? null;
  const buyableCommodities = location !== null ? Object.keys(location.producedCommodities) : [];
  const sellableCommodities = location !== null ? Object.keys(location.consumedCommodities) : [];

  // A Paste World/Reset swaps every Explorer/Location object out from under
  // any stale selection/dropdown -- fall back to the first still-valid
  // option rather than silently keeping a name that no longer resolves.
  useEffect(() => {
    if (buyCommodity === "" || !buyableCommodities.includes(buyCommodity)) {
      setBuyCommodity(buyableCommodities[0] ?? "");
    }
    if (sellCommodity === "" || !sellableCommodities.includes(sellCommodity)) {
      setSellCommodity(sellableCommodities[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, selectedExplorer, location]);

  if (world === null) return null;

  const pendingDecision = world.pendingDecision;
  const inventory = selectedExplorer?.porterParty.inventory ?? null;

  function handleBuy() {
    if (selectedExplorer === null || buyCommodity === "") return;
    const bought = buyAtVillage(selectedExplorer, buyCommodity, buyQuantity);
    setMessage(bought > 0 ? `Bought ${bought.toFixed(1)} ${buyCommodity}.` : "Nothing bought -- check cash/capacity.");
  }

  function handleSell() {
    if (selectedExplorer === null || sellCommodity === "") return;
    const sold = sellAtVillage(selectedExplorer, sellCommodity, sellQuantity);
    setMessage(sold > 0 ? `Sold ${sold.toFixed(1)} ${sellCommodity}.` : "Nothing sold -- check inventory.");
  }

  return (
    <div className="panel explorer-panel">
      <h2>Exploration</h2>
      {world.explorers.length === 0 ? (
        <p className="muted">No Explorer in this World.</p>
      ) : (
        <>
          <div className="scroll-table">
            <table>
              <thead>
                <tr>
                  <th>Explorer</th>
                  <th>Location</th>
                  <th>Destination</th>
                  <th>Days</th>
                  <th>Cash</th>
                </tr>
              </thead>
              <tbody>
                {world.explorers.map((explorer, i) => (
                  <tr
                    key={i}
                    className={explorer === selectedExplorer ? "fleet-row-selected" : undefined}
                    onClick={() => selectExplorer(explorer)}
                  >
                    <td>{explorer.name}</td>
                    <td>{explorer.locationName}</td>
                    <td>{explorer.destination ?? "-"}</td>
                    <td>{explorer.destination !== null ? explorer.daysRemaining : "-"}</td>
                    <td>${explorer.cash.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedExplorer !== null && (
            <div className="explorer-detail">
              <table>
                <tbody>
                  <tr>
                    <th>Inventory</th>
                    <td>
                      {inventory === null || Object.keys(inventory).length === 0
                        ? "-"
                        : Object.entries(inventory)
                            .map(([commodity, quantity]) => `${quantity.toFixed(1)} ${commodity}`)
                            .join(", ")}
                    </td>
                  </tr>
                </tbody>
              </table>

              {location !== null && (
                <div className="buy-ship-form">
                  {buyableCommodities.length > 0 && (
                    <>
                      <label className="speed-control">
                        Buy:
                        <select value={buyCommodity} onChange={(e) => setBuyCommodity(e.target.value)}>
                          {buyableCommodities.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={buyQuantity}
                        onChange={(e) => setBuyQuantity(Number(e.target.value))}
                      />
                      <button type="button" onClick={handleBuy} disabled={pendingDecision !== null}>
                        Buy
                      </button>
                    </>
                  )}
                  {sellableCommodities.length > 0 && (
                    <>
                      <label className="speed-control">
                        Sell:
                        <select value={sellCommodity} onChange={(e) => setSellCommodity(e.target.value)}>
                          {sellableCommodities.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={sellQuantity}
                        onChange={(e) => setSellQuantity(Number(e.target.value))}
                      />
                      <button type="button" onClick={handleSell} disabled={pendingDecision !== null}>
                        Sell
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => openLegChoice(selectedExplorer)}
                    disabled={pendingDecision !== null || selectedExplorer.destination !== null}
                  >
                    Choose next leg
                  </button>
                  {message !== null && <span className="stat">{message}</span>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
