import { useEditorStore } from "../state/useEditorStore";

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
