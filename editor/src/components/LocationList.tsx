import { useEditorStore } from "../state/useEditorStore";

/**
 * Each entry is already a single compact line, so there's nothing to
 * roll up per-item -- instead the whole list gets a bounded, independently
 * scrolling "rollup" pane (see .location-list's max-height in App.css) so a
 * World with many Locations scrolls within this list rather than growing
 * the sidebar and forcing it to scroll as a whole.
 */
export function LocationList() {
  const locations = useEditorStore((s) => s.locations);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectLocation = useEditorStore((s) => s.selectLocation);

  if (locations.length === 0) {
    return <div className="location-list location-list-empty">No locations yet.</div>;
  }

  return (
    <div className="location-list">
      {locations.map((loc) => (
        <button
          key={loc.id}
          type="button"
          className={`location-list-item${loc.id === selectedId ? " selected" : ""}`}
          onClick={() => selectLocation(loc.id)}
        >
          {loc.name}
        </button>
      ))}
    </div>
  );
}
