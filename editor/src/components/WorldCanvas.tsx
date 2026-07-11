/**
 * Click empty space to place a new Location there; click a pin to select it;
 * drag a pin to reposition it; shift-drag from one pin to another to create
 * a Route between them (blocked if either Location has no TerminalTypes --
 * see useEditorStore.addRoute); shift-drag on a Route itself to add a
 * control point and immediately position it. Once a control point exists,
 * no shift is needed: plain-drag its handle to move it, or plain-click it
 * (no drag) to remove it (a Route's curveType flips to Bezier/Straight
 * automatically as its control point count crosses 2 either way -- see
 * deriveRouteCurveType).
 */
import { useRef, useState } from "react";
import { useEditorStore, WORLD_ASPECT_RATIO, DEFAULT_WORLD_WIDTH } from "../state/useEditorStore";
import { routeRenderPoints, sortRouteControlPoints } from "../types";

/** World-unit radius of a Location pin's hit target -- matches the circle's rendered `r` below, used to hit-test where a shift-drag connection is released. */
const PIN_RADIUS = 10;

/** World-unit half-size of a Route control point's rendered handle -- also its counter-scaled render size (see the location-pin `<g>` transform pattern below). */
const CONTROL_POINT_SIZE = 5;

/** Screen-pixel movement below which releasing a dragged control point counts as a click (remove it) rather than a drag (leave it at its moved position). */
const CONTROL_POINT_CLICK_THRESHOLD_PX = 4;

export function WorldCanvas() {
  const locations = useEditorStore((s) => s.locations);
  const routes = useEditorStore((s) => s.routes);
  const selectedId = useEditorStore((s) => s.selectedId);
  const worldWidth = useEditorStore((s) => s.worldWidth);
  const pendingPoliticalEntityId = useEditorStore((s) => s.pendingPoliticalEntityId);
  const addLocation = useEditorStore((s) => s.addLocation);
  const selectLocation = useEditorStore((s) => s.selectLocation);
  const moveLocation = useEditorStore((s) => s.moveLocation);
  const addRoute = useEditorStore((s) => s.addRoute);
  const removeRoute = useEditorStore((s) => s.removeRoute);
  const addRouteControlPoint = useEditorStore((s) => s.addRouteControlPoint);
  const moveRouteControlPoint = useEditorStore((s) => s.moveRouteControlPoint);
  const removeRouteControlPoint = useEditorStore((s) => s.removeRouteControlPoint);
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null);
  const [connectingToPoint, setConnectingToPoint] = useState<{ x: number; y: number } | null>(null);
  const [draggingControlPoint, setDraggingControlPoint] = useState<{
    routeId: string;
    pointId: string;
    /** Screen coords at the start of this drag -- used to tell a plain click (remove) from a real drag (leave moved) apart on release. Not tracked for a freshly created point (see handleRoutePointerDown), which should never be deleted just for not having moved yet. */
    start: { x: number; y: number } | null;
  } | null>(null);

  const worldHeight = worldWidth / WORLD_ASPECT_RATIO;
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const connectingFrom = connectingFromId !== null ? locationById.get(connectingFromId) ?? null : null;
  const pinHitRadius = PIN_RADIUS * (worldWidth / DEFAULT_WORLD_WIDTH);

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
    if (e.shiftKey) {
      setConnectingFromId(id);
      setConnectingToPoint(toWorldPoint(e.clientX, e.clientY));
      return;
    }
    selectLocation(id);
    setDraggingId(id);
  }

  /** Shift-drag on a Route's own path (not an existing control point handle) adds a new control point at the click position and immediately starts dragging it -- one continuous gesture both creates and positions it. `start: null` so releasing without moving further never deletes it (see handlePointerUp) -- unlike grabbing an existing handle, a shift-click here was already an explicit "add a point" action. */
  function handleRoutePointerDown(e: React.PointerEvent<SVGPathElement>, routeId: string) {
    if (!e.shiftKey) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = toWorldPoint(e.clientX, e.clientY);
    const pointId = addRouteControlPoint(routeId, Math.round(x), Math.round(y));
    if (pointId !== null) setDraggingControlPoint({ routeId, pointId, start: null });
  }

  /** Plain drag on an existing control point handle moves it -- no shift required, once it exists. Releasing without moving past CONTROL_POINT_CLICK_THRESHOLD_PX counts as a click instead, removing it (see handlePointerUp). */
  function handleControlPointPointerDown(e: React.PointerEvent<SVGGElement>, routeId: string, pointId: string) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDraggingControlPoint({ routeId, pointId, start: { x: e.clientX, y: e.clientY } });
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const { x, y } = toWorldPoint(e.clientX, e.clientY);
    if (connectingFromId !== null) {
      setConnectingToPoint({ x, y });
      return;
    }
    if (draggingControlPoint !== null) {
      moveRouteControlPoint(draggingControlPoint.routeId, draggingControlPoint.pointId, Math.round(x), Math.round(y));
      return;
    }
    if (draggingId === null) return;
    moveLocation(draggingId, Math.round(x), Math.round(y));
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (draggingControlPoint !== null) {
      const { routeId, pointId, start } = draggingControlPoint;
      if (start !== null) {
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (moved <= CONTROL_POINT_CLICK_THRESHOLD_PX) removeRouteControlPoint(routeId, pointId);
      }
      setDraggingControlPoint(null);
      return;
    }
    if (connectingFromId !== null) {
      const { x, y } = toWorldPoint(e.clientX, e.clientY);
      const target = locations.find(
        (loc) => loc.id !== connectingFromId && Math.hypot(loc.x - x, loc.y - y) <= pinHitRadius,
      );
      if (target !== undefined) addRoute(connectingFromId, target.id);
      setConnectingFromId(null);
      setConnectingToPoint(null);
      return;
    }
    setDraggingId(null);
  }

  return (
    <div className="canvas-wrapper">
      {pendingPoliticalEntityId === null && (
        <div className="canvas-hint">
          Select (or create) a Political Entity in the sidebar before placing a Location
        </div>
      )}
      {connectingFrom !== null && connectingFrom.terminalTypes.length === 0 && (
        <div className="canvas-hint canvas-hint-warning">
          {connectingFrom.name} has no terminal types -- it can't be connected by a Route
        </div>
      )}
      <svg
        ref={svgRef}
        className="world-canvas"
        viewBox={`0 0 ${worldWidth} ${worldHeight}`}
        preserveAspectRatio="xMidYMid meet"
        onClick={handleBackgroundClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <defs>
          <clipPath id="world-clip">
            <rect x={0} y={0} width={worldWidth} height={worldHeight} />
          </clipPath>
        </defs>
        <rect className="world-bounds" x={0} y={0} width={worldWidth} height={worldHeight} />
        {/* Routes and Locations are clipped to the world bounds, so a Location
            left outside the current (e.g. shrunken) world size scrolls cleanly
            off the edge instead of lingering in the canvas's letterbox margin.
            Its coordinates are untouched (see setWorldWidth), so growing the
            world back reveals it in the same place. */}
        <g clipPath="url(#world-clip)">
        {routes.map((route) => {
          const a = locationById.get(route.locationAId);
          const b = locationById.get(route.locationBId);
          if (a === undefined || b === undefined) return null;
          const sortedPoints = sortRouteControlPoints(a, b, route.controlPoints);
          const renderPoints = routeRenderPoints(a, b, route.controlPoints);
          const d = `M ${renderPoints.map((p) => `${p.x} ${p.y}`).join(" L ")}`;
          const controlPointScale = worldWidth / DEFAULT_WORLD_WIDTH;
          return (
            <g key={route.id}>
              {/* Wide, invisible stroke -- the real hit target, since the visible path below is too thin (2px, non-scaling) to reliably click. */}
              <path
                className="route-hit-area"
                d={d}
                onPointerDown={(e) => handleRoutePointerDown(e, route.id)}
                onClick={(e) => {
                  // Always stop propagation here -- a shift-click that just
                  // added/moved a control point must not also bubble up to
                  // the canvas background's click handler (which would place
                  // a stray new Location). Only a plain (non-shift) click
                  // actually deletes the Route.
                  e.stopPropagation();
                  if (e.shiftKey) return;
                  removeRoute(route.id);
                }}
              />
              <path className="route-line" d={d} />
              {sortedPoints.map((p) => (
                <g
                  key={p.id}
                  transform={`translate(${p.x}, ${p.y}) scale(${controlPointScale})`}
                  onPointerDown={(e) => handleControlPointPointerDown(e, route.id, p.id)}
                  // Actual click-vs-drag handling lives in handlePointerUp
                  // (see CONTROL_POINT_CLICK_THRESHOLD_PX) -- this just stops
                  // the synthetic click that follows every pointerup (which
                  // targets this element regardless of drag distance, since
                  // it captured the pointer) from bubbling up to the canvas
                  // background's click handler and placing a stray Location.
                  onClick={(e) => e.stopPropagation()}
                  className="route-control-point"
                >
                  <rect
                    x={-CONTROL_POINT_SIZE}
                    y={-CONTROL_POINT_SIZE}
                    width={CONTROL_POINT_SIZE * 2}
                    height={CONTROL_POINT_SIZE * 2}
                  />
                </g>
              ))}
            </g>
          );
        })}
        {connectingFrom !== null && connectingToPoint !== null && (
          <line
            className={`route-line-pending${connectingFrom.terminalTypes.length === 0 ? " invalid" : ""}`}
            x1={connectingFrom.x}
            y1={connectingFrom.y}
            x2={connectingToPoint.x}
            y2={connectingToPoint.y}
          />
        )}
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
        </g>
      </svg>
    </div>
  );
}
