import { useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import type { ContractStrategy } from "../sim/faction";

export function ControlsPanel() {
  const playing = useSimStore((s) => s.playing);
  const day = useSimStore((s) => s.day);
  const date = useSimStore((s) => s.date);
  const secondsPerDay = useSimStore((s) => s.secondsPerDay);
  const contractStrategy = useSimStore((s) => s.contractStrategy);
  const shipLogEnabled = useSimStore((s) => s.shipLogEnabled);
  const factions = useSimStore((s) => s.factions);
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const step = useSimStore((s) => s.step);
  const reset = useSimStore((s) => s.reset);
  const loadWorldFromJson = useSimStore((s) => s.loadWorldFromJson);
  const setPlaying = useSimStore((s) => s.setPlaying);
  const setSecondsPerDay = useSimStore((s) => s.setSecondsPerDay);
  const setContractStrategy = useSimStore((s) => s.setContractStrategy);
  const setShipLogEnabled = useSimStore((s) => s.setShipLogEnabled);
  const addPirateShip = useSimStore((s) => s.addPirateShip);
  const removePirateShip = useSimStore((s) => s.removePirateShip);
  const addPoliceShip = useSimStore((s) => s.addPoliceShip);
  const removePoliceShip = useSimStore((s) => s.removePoliceShip);

  const [pasteError, setPasteError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handlePasteWorld() {
    setPasteError(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      setPasteError(`Could not read the clipboard: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (text.trim() === "") {
      setPasteError("Clipboard is empty -- copy a World from the editor first.");
      return;
    }
    try {
      loadWorldFromJson(text);
    } catch (err) {
      setPasteError(`Could not create a World from the clipboard: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleImportFile(file: File) {
    setPasteError(null);
    try {
      loadWorldFromJson(await file.text());
    } catch (err) {
      setPasteError(`Could not create a World from "${file.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const traderCount = world?.captains.length ?? 0;
  const locationCount = world?.locations.length ?? 0;
  // world mutates in place (see useSimStore's docstring) -- `version` is what
  // actually signals these counts changed, `world` itself never does.
  void version;
  const pirateCount = world?.pirateBrigade?.captains.length ?? 0;
  const policeCount = world?.policeFleet?.captains.length ?? 0;

  return (
    <div className="panel controls-panel">
      <button type="button" onClick={() => setPlaying(!playing)}>
        {playing ? "Pause" : "Play"}
      </button>
      <button type="button" onClick={step} disabled={playing}>
        Step
      </button>
      <button type="button" onClick={reset}>
        Reset
      </button>
      <button type="button" onClick={handlePasteWorld}>
        Paste World
      </button>
      <button type="button" onClick={() => fileInputRef.current?.click()}>
        Import World
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
          // Reset so re-selecting the same file still fires onChange.
          e.target.value = "";
        }}
      />
      <label className="speed-control">
        Speed: {secondsPerDay.toFixed(1)} s/day
        <input
          type="range"
          min={0.1}
          max={5}
          step={0.1}
          value={secondsPerDay}
          onChange={(e) => setSecondsPerDay(Number(e.target.value))}
        />
      </label>
      <label className="speed-control">
        Contracts:
        <select
          value={contractStrategy}
          onChange={(e) => setContractStrategy(e.target.value as ContractStrategy)}
        >
          <option value="compare">Compare by profit</option>
          <option value="prioritise">Prioritise over arbitrage</option>
        </select>
      </label>
      <label className="speed-control">
        <input
          type="checkbox"
          checked={shipLogEnabled}
          onChange={(e) => setShipLogEnabled(e.target.checked)}
        />
        Ship's Log
      </label>
      <label className="speed-control">
        Pirates: {pirateCount}
        <button type="button" onClick={addPirateShip}>+</button>
        <button type="button" onClick={removePirateShip} disabled={pirateCount === 0}>-</button>
      </label>
      <label className="speed-control">
        Police: {policeCount}
        <button type="button" onClick={addPoliceShip}>+</button>
        <button type="button" onClick={removePoliceShip} disabled={policeCount === 0}>-</button>
      </label>
      <span className="stat">Day {day}</span>
      {date !== null && (
        <span className="stat">
          {date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}
        </span>
      )}
      <span className="stat">{factions.length} factions</span>
      <span className="stat">{traderCount} traders</span>
      <span className="stat">{locationCount} locations</span>
      {pasteError !== null && <span className="paste-error" role="alert">{pasteError}</span>}
    </div>
  );
}
