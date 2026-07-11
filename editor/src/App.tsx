import { useEditorStore } from "./state/useEditorStore";
import { WorldCanvas } from "./components/WorldCanvas";
import { WorldSizeControl } from "./components/WorldSizeControl";
import { LocationList } from "./components/LocationList";
import { LocationInspector } from "./components/LocationInspector";
import { CommoditiesPanel } from "./components/CommoditiesPanel";
import { PoliticalEntitiesPanel } from "./components/PoliticalEntitiesPanel";
import { locationsToCsv, commoditiesToCsv, downloadCsv } from "./csvExport";
import "./App.css";

function App() {
  const locations = useEditorStore((s) => s.locations);
  const commodities = useEditorStore((s) => s.commodities);

  return (
    <div className="app">
      <header className="app-header">
        <h1>World Editor</h1>
        <WorldSizeControl />
        <button
          type="button"
          onClick={() => downloadCsv(commoditiesToCsv(commodities), "commodities.csv")}
          disabled={commodities.length === 0}
        >
          Export commodities.csv
        </button>
        <button
          type="button"
          onClick={() => downloadCsv(locationsToCsv(locations), "locations.csv")}
          disabled={locations.length === 0}
        >
          Export locations.csv
        </button>
      </header>
      <div className="app-body">
        <aside className="sidebar-left">
          <PoliticalEntitiesPanel />
          <div className="sidebar-section-header">Locations</div>
          <LocationList />
          <CommoditiesPanel />
        </aside>
        <main className="canvas-area">
          <WorldCanvas />
        </main>
        <aside className="sidebar-right">
          <LocationInspector />
        </aside>
      </div>
    </div>
  );
}

export default App;
