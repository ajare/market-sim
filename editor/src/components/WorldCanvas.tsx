/** Click empty space to place a new Location there; click a pin to select it; drag a pin to reposition it. */
import { useRef, useState } from "react";
import { useEditorStore, WORLD_ASPECT_RATIO, DEFAULT_WORLD_WIDTH } from "../state/useEditorStore";

export function WorldCanvas() {
  const locations = useEditorStore((s) => s.locations);
  const selectedId = useEditorStore((s) => s.selectedId);
  const worldWidth = useEditorStore((s) => s.worldWidth);
  const addLocation = useEditorStore((s) => s.addLocation);
  const selectLocation = useEditorStore((s) => s.selectLocation);
  const moveLocation = useEditorStore((s) => s.moveLocation);
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const worldHeight = worldWidth / WORLD_ASPECT_RATIO;

  // The SVG's viewBox scales world units to screen pixels, so a click's
  // clientX/clientY must go through the SVG's own screen-to-user-space
  // transform (not a naive rect-relative subtraction) to land at the right
  // world coordinate.
  function toWorldPoint(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current!;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const ctm = svg.getScreenCTM();
    if (ctm === null) return { x: 0, y: 0 };
    const local = point.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  function handleBackgroundClick(e: React.MouseEvent<SVGSVGElement>) {
    if (draggingId !== null) return;
    const { x, y } = toWorldPoint(e.clientX, e.clientY);
    addLocation(Math.round(x), Math.round(y));
  }

  function handlePinPointerDown(e: React.PointerEvent<SVGGElement>, id: string) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    selectLocation(id);
    setDraggingId(id);
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (draggingId === null) return;
    const { x, y } = toWorldPoint(e.clientX, e.clientY);
    moveLocation(draggingId, Math.round(x), Math.round(y));
  }

  function handlePointerUp() {
    setDraggingId(null);
  }

  return (
    <svg
      ref={svgRef}
      className="world-canvas"
      viewBox={`0 0 ${worldWidth} ${worldHeight}`}
      preserveAspectRatio="xMidYMid meet"
      onClick={handleBackgroundClick}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <rect className="world-bounds" x={0} y={0} width={worldWidth} height={worldHeight} />
      {locations.map((loc) => (
        // The inner scale counteracts the viewBox's own scaling (tied to
        // worldWidth) so the pin/label render at a constant screen size
        // regardless of how large or small the World currently is.
        <g
          key={loc.id}
          transform={`translate(${loc.x}, ${loc.y}) scale(${worldWidth / DEFAULT_WORLD_WIDTH})`}
          onPointerDown={(e) => handlePinPointerDown(e, loc.id)}
          onClick={(e) => e.stopPropagation()}
          className={`location-pin${loc.id === selectedId ? " selected" : ""}`}
        >
          <circle r={10} />
          <text y={-16} textAnchor="middle">
            {loc.name}
          </text>
        </g>
      ))}
    </svg>
  );
}
