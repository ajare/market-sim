import { useSimStore } from "../state/useSimStore";

export function ControlsPanel() {
  const playing = useSimStore((s) => s.playing);
  const day = useSimStore((s) => s.day);
  const daysPerSecond = useSimStore((s) => s.daysPerSecond);
  const factions = useSimStore((s) => s.factions);
  const world = useSimStore((s) => s.world);
  const step = useSimStore((s) => s.step);
  const reset = useSimStore((s) => s.reset);
  const setPlaying = useSimStore((s) => s.setPlaying);
  const setDaysPerSecond = useSimStore((s) => s.setDaysPerSecond);

  const traderCount = world?.captains.length ?? 0;
  const locationCount = world?.locations.length ?? 0;

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
      <label className="speed-control">
        Speed: {daysPerSecond.toFixed(1)} days/s
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.5}
          value={daysPerSecond}
          onChange={(e) => setDaysPerSecond(Number(e.target.value))}
        />
      </label>
      <span className="stat">Day {day}</span>
      <span className="stat">{factions.length} factions</span>
      <span className="stat">{traderCount} traders</span>
      <span className="stat">{locationCount} locations</span>
    </div>
  );
}
