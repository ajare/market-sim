/**
 * Click empty space to place a new Location there; click a pin to select it;
 * drag a pin to reposition it; shift-drag from one pin to another to create
 * a Route between them (blocked if either Location has no TerminalTypes --
 * see useEditorStore.addRoute); shift-drag on a Route itself to add a
 * control point and immediately position it. Once a control point exists,
 * no shift is needed: plain-drag its handle to move it, or plain-click it
 * (no drag) to remove it (the rendered curve -- see routeRenderPoints --
 * follows directly from the control point count, smoothing automatically
 * as it changes). Mousewheel/trackpad scroll zooms, centered on the cursor
 * (see the `camera` state); "h" resets the view (zoom 1, centered).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEditorStore } from "../state/useEditorStore";
import { routeRenderPoints, sortRouteControlPoints, type RouteControlPoint } from "../types";

/** Pixel radius of a Location pin's rendered circle -- also its hit-test radius for releasing a shift-drag connection. */
const PIN_RADIUS = 10;

/** Pixel half-size of a Route control point's rendered handle. */
const CONTROL_POINT_SIZE = 5;

/** Screen-pixel movement below which releasing a dragged control point counts as a click (remove it) rather than a drag (leave it at its moved position). */
const CONTROL_POINT_CLICK_THRESHOLD_PX = 4;

/**
 * Zoom bounds. MIN_ZOOM is 1, not some fraction below it: `size.w`/`size.h`
 * double as both the canvas's actual screen-pixel dimensions AND the
 * world's own extent (Locations are normalized [0,1] then scaled by that
 * same `size`, and the world-bounds rect is drawn at exactly (0,0)-(size.w,
 * size.h)) -- so world-pixel-units-per-screen-pixel is exactly `zoom`,
 * meaning zoom 1 is precisely the point where the world fills the canvas.
 * Anything below 1 would render the world smaller than the canvas, leaving
 * empty margin around it -- exactly what this clamp prevents. MAX_ZOOM (20x
 * in) is just a practical cap for placing tightly-clustered Locations.
 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;

/** deltaY-to-zoom-factor sensitivity: a standard mouse wheel notch (deltaY ~= 100) gives roughly a 10% step; trackpad pinch/scroll (many small deltaY events) zooms smoothly. */
const ZOOM_SENSITIVITY = 0.001;

export function WorldCanvas() {
  const locations = useEditorStore((s) => s.locations);
  const routes = useEditorStore((s) => s.routes);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectedRouteId = useEditorStore((s) => s.selectedRouteId);
  const backgroundImage = useEditorStore((s) => s.backgroundImage);
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const addLocation = useEditorStore((s) => s.addLocation);
  const selectLocation = useEditorStore((s) => s.selectLocation);
  const moveLocation = useEditorStore((s) => s.moveLocation);
  const addRoute = useEditorStore((s) => s.addRoute);
  const selectRoute = useEditorStore((s) => s.selectRoute);
  const addRouteControlPoint = useEditorStore((s) => s.addRouteControlPoint);
  const moveRouteControlPoint = useEditorStore((s) => s.moveRouteControlPoint);
  const removeRouteControlPoint = useEditorStore((s) => s.removeRouteControlPoint);
  const svgRef = useRef<SVGSVGElement>(null);
  // The canvas is rendered in world-pixel space: at camera zoom 1/offset 0,
  // the viewBox equals the SVG's own pixel size, so 1 user unit == 1px (see
  // `camera` below for how zoom/pan shift the viewBox away from that).
  // Locations/control points are stored NORMALIZED in [0,1] and rendered at
  // (n.x * size.w, n.y * size.h) -- always against this base `size`,
  // independent of the current camera; a click maps back to normalized by
  // dividing by the same size, after first mapping through the camera via
  // toPixelPoint/getScreenCTM.
  const [size, setSize] = useState({ w: 1, h: 1 });
  // Pan/zoom viewport, in world-pixel space (same units as `size` -- offsetX/
  // offsetY are the world-pixel coordinate at the viewBox's top-left corner,
  // zoom 1 shows exactly `size` world-pixels). Local/transient view state,
  // not part of the authored World -- resets on remount, never saved.
  const [camera, setCamera] = useState({ zoom: 1, offsetX: 0, offsetY: 0 });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null);
  /** The moving end of an in-progress connection line, in PIXEL coordinates. */
  const [connectingToPoint, setConnectingToPoint] = useState<{ x: number; y: number } | null>(null);
  const [draggingControlPoint, setDraggingControlPoint] = useState<{
    routeId: string;
    pointId: string;
    /** Screen coords at the start of this drag -- used to tell a plain click (remove) from a real drag (leave moved) apart on release. Not tracked for a freshly created point (see handleRoutePointerDown), which should never be deleted just for not having moved yet. */
    start: { x: number; y: number } | null;
  } | null>(null);
  /** An open "which PoliticalEntity owns this new Location?" menu: its pixel position within the canvas (for placing the menu) and the normalized [0,1] point the Location would be created at. Null when no menu is open. */
  const [placeMenu, setPlaceMenu] = useState<{ pixelX: number; pixelY: number; normX: number; normY: number } | null>(
    null,
  );

  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const connectingFrom = connectingFromId !== null ? locationById.get(connectingFromId) ?? null : null;

  /** A stored normalized point (or Location) at its pixel position on the canvas. */
  const toPx = (p: { x: number; y: number }) => ({ x: p.x * size.w, y: p.y * size.h });

  // Keep the viewBox in sync with the SVG's actual pixel size (measured before
  // paint to avoid a first-frame flash), so 1 unit == 1px and the world fills
  // the middle exactly.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const update = () => {
      const w = svg.clientWidth;
      const h = svg.clientHeight;
      if (w > 0 && h > 0) setSize({ w, h });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  // Mousewheel/trackpad-gesture zoom, centered on the cursor -- registered as
  // a native (non-passive) listener so preventDefault actually stops the page
  // itself from scrolling/pinch-zooming (React's onWheel is passive and can't
  // do this). getScreenCTM() is read live at event time, so it always
  // reflects the viewBox as of the current render regardless of when this
  // effect last ran -- no dependency on `camera`/`size` needed.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const point = svg.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (ctm === null) return;
      // The world-pixel point currently under the cursor -- held fixed on
      // screen as zoom changes, so zooming feels anchored to the cursor
      // rather than the canvas center.
      const cursorWorld = point.matrixTransform(ctm.inverse());
      const zoomFactor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY);
      setCamera((prev) => {
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * zoomFactor));
        const scale = prev.zoom / newZoom;
        return {
          zoom: newZoom,
          offsetX: cursorWorld.x - (cursorWorld.x - prev.offsetX) * scale,
          offsetY: cursorWorld.y - (cursorWorld.y - prev.offsetY) * scale,
        };
      });
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, []);

  // "h" resets the camera to zoom 1/offset (0,0) -- at MIN_ZOOM the world
  // exactly fills the canvas (see MIN_ZOOM's own comment), so this both
  // centers and fully re-fits it in one shortcut, undoing any amount of
  // prior pan/zoom. Skipped while a text input/select/textarea has focus
  // (e.g. the Location name field) so typing a name containing "h" doesn't
  // reset the view out from under the user.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "h" && e.key !== "H") return;
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active as HTMLElement)?.isContentEditable) {
        return;
      }
      setCamera({ zoom: 1, offsetX: 0, offsetY: 0 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Escape closes the open placement menu (same as picking "<cancel>").
  useEffect(() => {
    if (placeMenu === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlaceMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placeMenu]);

  // A client (screen) point mapped through the SVG's own transform to pixel
  // (viewBox) coordinates.
  function toPixelPoint(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current!;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const ctm = svg.getScreenCTM();
    if (ctm === null) return { x: 0, y: 0 };
    const local = point.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  /** A client point mapped to NORMALIZED [0,1] canvas coordinates (what the store stores). */
  function toNormalizedPoint(clientX: number, clientY: number): { x: number; y: number } {
    const { x, y } = toPixelPoint(clientX, clientY);
    return { x: size.w > 0 ? x / size.w : 0, y: size.h > 0 ? y / size.h : 0 };
  }

  function handleBackgroundClick(e: React.MouseEvent<SVGSVGElement>) {
    if (draggingId !== null) return;
    // Open the owner-picking menu at the click, rather than placing straight
    // away -- the chosen PoliticalEntity (or "<cancel>") drives creation.
    const svg = svgRef.current;
    if (svg === null) return;
    const rect = svg.getBoundingClientRect();
    const { x, y } = toNormalizedPoint(e.clientX, e.clientY);
    setPlaceMenu({ pixelX: e.clientX - rect.left, pixelY: e.clientY - rect.top, normX: x, normY: y });
  }

  /** Create the pending Location under `politicalEntityId` and close the menu. */
  function confirmPlacement(politicalEntityId: string) {
    if (placeMenu === null) return;
    addLocation(placeMenu.normX, placeMenu.normY, politicalEntityId);
    setPlaceMenu(null);
  }

  function handlePinPointerDown(e: React.PointerEvent<SVGGElement>, id: string) {
    e.stopPropagation();
    setPlaceMenu(null);
    (e.target as Element).setPointerCapture(e.pointerId);
    if (e.shiftKey) {
      setConnectingFromId(id);
      setConnectingToPoint(toPixelPoint(e.clientX, e.clientY));
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
    // Select the Route so its control points (including this new one) render --
    // they are only shown for the selected Route.
    selectRoute(routeId);
    const { x, y } = toNormalizedPoint(e.clientX, e.clientY);
    const pointId = addRouteControlPoint(routeId, x, y);
    if (pointId !== null) setDraggingControlPoint({ routeId, pointId, start: null });
  }

  /** Plain drag on an existing control point handle moves it -- no shift required, once it exists. Releasing without moving past CONTROL_POINT_CLICK_THRESHOLD_PX counts as a click instead, removing it (see handlePointerUp). */
  function handleControlPointPointerDown(e: React.PointerEvent<SVGGElement>, routeId: string, pointId: string) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDraggingControlPoint({ routeId, pointId, start: { x: e.clientX, y: e.clientY } });
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (connectingFromId !== null) {
      setConnectingToPoint(toPixelPoint(e.clientX, e.clientY));
      return;
    }
    if (draggingControlPoint !== null) {
      const { x, y } = toNormalizedPoint(e.clientX, e.clientY);
      moveRouteControlPoint(draggingControlPoint.routeId, draggingControlPoint.pointId, x, y);
      return;
    }
    if (draggingId === null) return;
    const { x, y } = toNormalizedPoint(e.clientX, e.clientY);
    moveLocation(draggingId, x, y);
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
      // Release lands on a Location if it's within PIN_RADIUS SCREEN pixels
      // of one -- release/px are in world-pixel space (via toPixelPoint/
      // toPx), and a pin now renders at a constant PIN_RADIUS screen size
      // regardless of zoom (see the location-pin group's scale(1/zoom)
      // below), so the threshold has to be converted to world-pixel units by
      // dividing by zoom too, or it'd stop matching the rendered pin size at
      // any zoom other than 1x.
      const release = toPixelPoint(e.clientX, e.clientY);
      const target = locations.find((loc) => {
        if (loc.id === connectingFromId) return false;
        const px = toPx(loc);
        return Math.hypot(px.x - release.x, px.y - release.y) <= PIN_RADIUS / camera.zoom;
      });
      if (target !== undefined) addRoute(connectingFromId, target.id);
      setConnectingFromId(null);
      setConnectingToPoint(null);
      return;
    }
    setDraggingId(null);
  }

  return (
    <div className="canvas-wrapper">
      {backgroundImage !== null && (
        // A plain HTML image sized to the canvas wrapper, behind the SVG. The
        // SVG's own background and world-bounds fill go transparent (see the
        // has-background class) so this shows through. At camera zoom 1/
        // offset 0 the image maps 1:1 onto world-pixel space (that's the
        // reference alignment users trace Locations against), so this
        // transform -- scale(zoom) then translate by -offset*zoom, matching
        // the SVG viewBox's own mapping -- keeps it pixel-locked to the SVG
        // content at any zoom/pan.
        <img
          className="canvas-background"
          src={backgroundImage}
          alt=""
          draggable={false}
          style={{ transform: `translate(${-camera.offsetX * camera.zoom}px, ${-camera.offsetY * camera.zoom}px) scale(${camera.zoom})` }}
        />
      )}
      {politicalEntities.length === 0 && (
        <div className="canvas-hint">
          Create a Political Entity in the sidebar before placing a Location
        </div>
      )}
      {connectingFrom !== null && connectingFrom.terminalTypes.length === 0 && (
        <div className="canvas-hint canvas-hint-warning">
          {connectingFrom.name} has no terminal types -- it can't be connected by a Route
        </div>
      )}
      <svg
        ref={svgRef}
        className={`world-canvas${backgroundImage !== null ? " has-background" : ""}`}
        viewBox={`${camera.offsetX} ${camera.offsetY} ${size.w / camera.zoom} ${size.h / camera.zoom}`}
        preserveAspectRatio="xMidYMid meet"
        onClick={handleBackgroundClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <defs>
          <clipPath id="world-clip">
            <rect x={0} y={0} width={size.w} height={size.h} />
          </clipPath>
        </defs>
        <rect className="world-bounds" x={0} y={0} width={size.w} height={size.h} />
        {/* Routes and Locations are clipped to the canvas bounds. */}
        <g clipPath="url(#world-clip)">
        {routes.map((route) => {
          const a = locationById.get(route.locationAId);
          const b = locationById.get(route.locationBId);
          if (a === undefined || b === undefined) return null;
          // Everything renders in pixel space, so map the stored normalized
          // Locations/control points up to pixels first.
          const aPx = toPx(a);
          const bPx = toPx(b);
          const controlPointsPx: RouteControlPoint[] = route.controlPoints.map((p) => ({ ...p, ...toPx(p) }));
          const sortedPoints = sortRouteControlPoints(aPx, bPx, controlPointsPx);
          const renderPoints = routeRenderPoints(aPx, bPx, controlPointsPx);
          const d = `M ${renderPoints.map((p) => `${p.x} ${p.y}`).join(" L ")}`;
          const isSelected = route.id === selectedRouteId;
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
                  // a stray new Location). A plain (non-shift) click SELECTS
                  // the Route (shown in the RouteInspector panel); deleting is
                  // done from that panel, never by clicking the Route.
                  e.stopPropagation();
                  if (e.shiftKey) return;
                  selectRoute(route.id);
                }}
              />
              <path className={`route-line${isSelected ? " selected" : ""}`} d={d} />
              {/* Control points are only shown (and editable) for the selected Route. */}
              {isSelected && sortedPoints.map((p) => (
                <g
                  key={p.id}
                  // scale(1/zoom) after the translate counters the viewBox's
                  // own zoom scaling for this subtree, so the handle stays a
                  // constant screen size while its position still moves
                  // correctly with zoom/pan (translate is in world-pixel
                  // coords, mapped by the viewBox exactly as everything else).
                  transform={`translate(${p.x}, ${p.y}) scale(${1 / camera.zoom})`}
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
            x1={toPx(connectingFrom).x}
            y1={toPx(connectingFrom).y}
            x2={connectingToPoint.x}
            y2={connectingToPoint.y}
          />
        )}
        {locations.map((loc) => {
          const px = toPx(loc);
          return (
            <g
              key={loc.id}
              // scale(1/zoom) after the translate keeps the pin/label a
              // constant screen size regardless of zoom -- see the matching
              // comment on the control-point handle above.
              transform={`translate(${px.x}, ${px.y}) scale(${1 / camera.zoom})`}
              onPointerDown={(e) => handlePinPointerDown(e, loc.id)}
              onClick={(e) => e.stopPropagation()}
              className={`location-pin${loc.id === selectedId ? " selected" : ""}`}
            >
              <circle r={PIN_RADIUS} />
              <text y={-16} textAnchor="middle">
                {loc.name}
              </text>
            </g>
          );
        })}
        </g>
      </svg>
      {placeMenu !== null && (
        <div
          className="placement-menu"
          style={{ left: placeMenu.pixelX, top: placeMenu.pixelY }}
          role="menu"
        >
          <div className="placement-menu-header">Owner</div>
          {politicalEntities.map((entity) => (
            <button
              key={entity.id}
              type="button"
              className="placement-menu-item"
              role="menuitem"
              onClick={() => confirmPlacement(entity.id)}
            >
              {entity.name}
            </button>
          ))}
          {politicalEntities.length === 0 && (
            <div className="placement-menu-empty">No Political Entities defined</div>
          )}
          <button
            type="button"
            className="placement-menu-item placement-menu-cancel"
            role="menuitem"
            onClick={() => setPlaceMenu(null)}
          >
            &lt;cancel&gt;
          </button>
        </div>
      )}
    </div>
  );
}
