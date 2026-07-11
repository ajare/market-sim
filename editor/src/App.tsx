import { useRef, useState } from "react";
import { useEditorStore } from "./state/useEditorStore";
import { WorldCanvas } from "./components/WorldCanvas";
import { WorldSizeControl } from "./components/WorldSizeControl";
import { LocationList } from "./components/LocationList";
import { LocationInspector } from "./components/LocationInspector";
import { CommoditiesPanel } from "./components/CommoditiesPanel";
import { CompaniesPanel } from "./components/CompaniesPanel";
import { PoliticalEntitiesPanel } from "./components/PoliticalEntitiesPanel";
import { worldToJson, parseWorldJson, downloadJson } from "./worldJson";
import "./App.css";

function App() {
  const worldWidth = useEditorStore((s) => s.worldWidth);
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const locations = useEditorStore((s) => s.locations);
  const commodities = useEditorStore((s) => s.commodities);
  const companies = useEditorStore((s) => s.companies);
  const routes = useEditorStore((s) => s.routes);
  const loadWorld = useEditorStore((s) => s.loadWorld);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const isEmpty =
    locations.length === 0 && commodities.length === 0 && companies.length === 0 && politicalEntities.length === 0;

  function currentWorldJson(): string {
    return worldToJson({ worldWidth, politicalEntities, locations, commodities, companies, routes });
  }

  function handleExport() {
    downloadJson(currentWorldJson(), "world.json");
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(currentWorldJson());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      window.alert(`Could not copy World to clipboard: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleImportFile(file: File) {
    try {
      loadWorld(parseWorldJson(await file.text()));
    } catch (err) {
      window.alert(`Could not import World: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>World Editor</h1>
        <WorldSizeControl />
        <button type="button" onClick={handleExport} disabled={isEmpty}>
          Export world.json
        </button>
        <button type="button" onClick={handleCopy} disabled={isEmpty}>
          {copied ? "Copied!" : "Copy JSON"}
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          Import world.json
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportFile(file);
            // Reset so re-selecting the same file still fires onChange.
            e.target.value = "";
          }}
        />
      </header>
      <div className="app-body">
        <aside className="sidebar-left">
          <PoliticalEntitiesPanel />
          <div className="sidebar-section-header">Locations</div>
          <LocationList />
          <CommoditiesPanel />
          <CompaniesPanel />
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
