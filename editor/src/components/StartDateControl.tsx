/**
 * Datetime input for the World's starting date/time (day 1) -- stored and
 * exported as an ISO 8601 string (see worldJson.ts), consumed by the sim's
 * World to seed its calendar (World.currentDate advances one day per step).
 */
import { useEditorStore } from "../state/useEditorStore";

/** `<input type="datetime-local">` reads/writes "YYYY-MM-DDTHH:mm" in the browser's local time zone, with no timezone offset -- converting through this (rather than toISOString, which would shift by the local UTC offset) keeps the displayed value stable regardless of the user's time zone. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(value: string): string {
  return new Date(value).toISOString();
}

export function StartDateControl() {
  const startDate = useEditorStore((s) => s.startDate);
  const setStartDate = useEditorStore((s) => s.setStartDate);

  return (
    <label className="start-date-control">
      Start date
      <input
        type="datetime-local"
        value={toLocalInputValue(startDate)}
        onChange={(e) => {
          if (e.target.value === "") return;
          setStartDate(fromLocalInputValue(e.target.value));
        }}
      />
    </label>
  );
}
