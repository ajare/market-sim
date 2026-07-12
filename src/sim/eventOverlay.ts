/**
 * Maps World.eventLog entries onto a specific (location, commodity) market so
 * chart panels can overlay "did something happen here" markers. An event is
 * relevant to a market if its scope actually reaches that location+commodity:
 * Worldwide reaches everything, Global reaches one commodity everywhere,
 * Location reaches every commodity at one place, Local and Closure are both
 * scoped to one exact place (Local additionally to one commodity).
 */
import type { Event } from "./events";

export type EventCategory = "Local" | "Location" | "Global" | "Worldwide" | "Closure";

export interface EventMarker {
  day: number;
  category: EventCategory;
  message: string;
  durationDays: number;
  /** The (location, commodity) pair this marker was resolved against -- lets a chart that overlays two locations (e.g. a buy/sell price comparison) say which side an event belongs to. */
  location: string;
  commodity: string;
}

/** Most-to-least severe -- used to pick which color "wins" when several events land on the same day. */
export const EVENT_CATEGORY_PRIORITY: EventCategory[] = ["Closure", "Worldwide", "Global", "Location", "Local"];

function eventCategoryOf(event: Event): EventCategory | null {
  switch (event.type) {
    case "Local":
    case "Location":
    case "Global":
    case "Worldwide":
    case "Closure":
      return event.type;
    default:
      return null;
  }
}

export function relevantEvents(events: readonly Event[], location: string, commodity: string): EventMarker[] {
  const markers: EventMarker[] = [];
  for (const e of events) {
    if (e.day === null) continue;
    const category = eventCategoryOf(e);
    if (category === null) continue;
    const matches =
      category === "Worldwide" ||
      (category === "Global" && e.subject === commodity) ||
      (category === "Location" && e.scope === location) ||
      (category === "Local" && e.scope === location && e.subject === commodity) ||
      (category === "Closure" && e.subject === location);
    if (matches) markers.push({ day: e.day, category, message: e.message, durationDays: e.duration, location, commodity });
  }
  return markers;
}

export function groupMarkersByDay(markers: EventMarker[]): Map<number, EventMarker[]> {
  const byDay = new Map<number, EventMarker[]>();
  for (const m of markers) {
    const list = byDay.get(m.day);
    if (list !== undefined) list.push(m);
    else byDay.set(m.day, [m]);
  }
  return byDay;
}

/** The color-priority-winning category for a cluster of same-day markers. */
export function topCategory(markers: EventMarker[]): EventCategory {
  for (const category of EVENT_CATEGORY_PRIORITY) {
    if (markers.some((m) => m.category === category)) return category;
  }
  return markers[0].category;
}
