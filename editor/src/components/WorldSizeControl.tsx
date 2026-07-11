/** Slider for the World's width (100-1000 units); height always follows at a fixed 4:3 ratio. */
import { useEditorStore, WORLD_ASPECT_RATIO, MIN_WORLD_WIDTH, MAX_WORLD_WIDTH } from "../state/useEditorStore";

export function WorldSizeControl() {
  const worldWidth = useEditorStore((s) => s.worldWidth);
  const setWorldWidth = useEditorStore((s) => s.setWorldWidth);
  const worldHeight = Math.round(worldWidth / WORLD_ASPECT_RATIO);

  return (
    <div className="world-size-control">
      <label htmlFor="world-width-slider">World size</label>
      <input
        id="world-width-slider"
        type="range"
        min={MIN_WORLD_WIDTH}
        max={MAX_WORLD_WIDTH}
        value={worldWidth}
        onChange={(e) => setWorldWidth(Number(e.target.value))}
      />
      <span className="world-size-value">
        {worldWidth} &times; {worldHeight}
      </span>
    </div>
  );
}
