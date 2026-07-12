/**
 * Shared canvas drawing + hit-testing for the event-marker lane overlaid at
 * the top of a time-series chart (see StockHistoryPanel / PriceHistoryPanel).
 * Kept separate from any one chart component since both overlay the same
 * kind of annotation track.
 */
import { groupMarkersByDay, topCategory, type EventCategory, type EventMarker } from "../sim/eventOverlay";

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  Local: "Local (this market)",
  Location: "Location-wide",
  Global: "Global (this commodity)",
  Worldwide: "Worldwide",
  Closure: "Port closure",
};

export function eventCategoryColor(category: EventCategory, cssVar: (name: string, fallback: string) => string): string {
  switch (category) {
    case "Local":
      return cssVar("--event-local", "#2a78d6");
    case "Location":
      return cssVar("--event-location", "#eda100");
    case "Global":
      return cssVar("--event-global", "#008300");
    case "Worldwide":
      return cssVar("--event-worldwide", "#e87ba4");
    case "Closure":
      return cssVar("--event-closure", "#e34948");
  }
}

const MARKER_RADIUS = 4;
const HIT_RADIUS_PX = 7;

export function drawEventMarkerLane(
  ctx: CanvasRenderingContext2D,
  markers: EventMarker[],
  px: (day: number) => number,
  markerY: number,
  surfaceColor: string,
  cssVar: (name: string, fallback: string) => string,
): void {
  const byDay = groupMarkersByDay(markers);
  for (const dayMarkers of byDay.values()) {
    const day = dayMarkers[0].day;
    const color = eventCategoryColor(topCategory(dayMarkers), cssVar);
    const x = px(day);
    ctx.beginPath();
    ctx.arc(x, markerY, MARKER_RADIUS + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = surfaceColor;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, markerY, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** Returns the day (and its full marker list) whose lane dot is under (mouseX, mouseY), or null. */
export function hitTestEventMarkers(
  markers: EventMarker[],
  px: (day: number) => number,
  markerY: number,
  mouseX: number,
  mouseY: number,
): { day: number; markers: EventMarker[] } | null {
  if (Math.abs(mouseY - markerY) > HIT_RADIUS_PX + 3) return null;
  const byDay = groupMarkersByDay(markers);
  let best: { day: number; markers: EventMarker[] } | null = null;
  let bestDist = Infinity;
  for (const [day, dayMarkers] of byDay) {
    const dist = Math.abs(px(day) - mouseX);
    if (dist <= HIT_RADIUS_PX && dist < bestDist) {
      bestDist = dist;
      best = { day, markers: dayMarkers };
    }
  }
  return best;
}
