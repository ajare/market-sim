/**
 * Number input (with up/down arrows) for the World scale -- the multiplier
 * applied to each Location's normalized [0,1] canvas position to produce its
 * world (exported/simulation) position. Purely a coordinate multiplier; it
 * never changes the editor's visual layout.
 */
import { useEditorStore, MIN_WORLD_SCALE, MAX_WORLD_SCALE } from "../state/useEditorStore";

export function WorldScaleControl() {
  const worldScale = useEditorStore((s) => s.worldScale);
  const setWorldScale = useEditorStore((s) => s.setWorldScale);

  return (
    <label className="world-scale-control">
      World scale
      <input
        type="number"
        min={MIN_WORLD_SCALE}
        max={MAX_WORLD_SCALE}
        step={1}
        value={worldScale}
        onChange={(e) => setWorldScale(Number(e.target.value))}
      />
    </label>
  );
}
