import { useEffect, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { Company, SoloTrader } from "../sim/faction";
import { SHIP_CLASSES } from "../sim/transport";

/**
 * Manual "Buy Ship" action for a Company (see World.buyShipForCompany) --
 * SoloTrader is excluded even though it's a Company subclass, since its own
 * ship-buying is meant to be automatic (a not-yet-built feature) rather than
 * a manual UI action. Autonomous Company fleet growth is also a future
 * feature; this panel is the whole of what exists today.
 */
export function BuyShipPanel() {
  const world = useSimStore((s) => s.world);
  const factions = useSimStore((s) => s.factions);
  const version = useSimStore((s) => s.version);
  const buyShip = useSimStore((s) => s.buyShip);

  const companies = factions.filter((f): f is Company => f instanceof Company && !(f instanceof SoloTrader));
  const shipClassNames = Object.keys(SHIP_CLASSES);
  const portLocations = (world?.locations ?? []).filter(
    (loc) => loc.terminalTypes.has("Port") || loc.terminalTypes.has("Platform"),
  );

  const [companyIndex, setCompanyIndex] = useState(0);
  const [locationName, setLocationName] = useState("");
  const [shipClassName, setShipClassName] = useState(shipClassNames[0]);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  // A Paste World/Reset swaps every Company/Location object out from under
  // any stale selection -- fall back to the first still-valid option rather
  // than silently keeping an index/name that no longer resolves.
  useEffect(() => {
    if (companyIndex >= companies.length) setCompanyIndex(0);
    if (locationName === "" || !portLocations.some((l) => l.name === locationName)) {
      setLocationName(portLocations[0]?.name ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, world]);

  if (world === null) return null;

  const selectedCompany = companies[companyIndex] ?? null;
  const shipClass = SHIP_CLASSES[shipClassName];
  const price = shipClass?.purchasePrice ?? 0;
  const canAfford = selectedCompany !== null && selectedCompany.cash >= price;

  function handleBuy() {
    if (selectedCompany === null || locationName === "") return;
    setMessage(null);
    try {
      buyShip(selectedCompany, locationName, shipClassName);
      setMessage({ text: `Bought a ${shipClassName} for ${selectedCompany.name} at ${locationName}.`, error: false });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  }

  return (
    <div className="panel buy-ship-panel">
      <h2>Buy Ship</h2>
      {companies.length === 0 ? (
        <p className="muted">No Companies to buy a Ship for.</p>
      ) : portLocations.length === 0 ? (
        <p className="muted">No Port or Platform Location exists in this World.</p>
      ) : (
        <div className="buy-ship-form">
          <label className="speed-control">
            Company:
            <select value={companyIndex} onChange={(e) => setCompanyIndex(Number(e.target.value))}>
              {companies.map((c, i) => (
                <option key={i} value={i}>
                  {c.name} (${c.cash.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
          <label className="speed-control">
            Location:
            <select value={locationName} onChange={(e) => setLocationName(e.target.value)}>
              {portLocations.map((loc) => (
                <option key={loc.name} value={loc.name}>
                  {loc.name}
                </option>
              ))}
            </select>
          </label>
          <label className="speed-control">
            Ship class:
            <select value={shipClassName} onChange={(e) => setShipClassName(e.target.value)}>
              {shipClassNames.map((name) => (
                <option key={name} value={name}>
                  {name} (${SHIP_CLASSES[name].purchasePrice.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={handleBuy} disabled={!canAfford}>
            Buy for ${price.toLocaleString()}
          </button>
          {message !== null && <span className={message.error ? "paste-error" : "stat"}>{message.text}</span>}
        </div>
      )}
    </div>
  );
}
