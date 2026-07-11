import { useRef, useState } from "react";
import { useEditorStore } from "./state/useEditorStore";
import { WorldCanvas } from "./components/WorldCanvas";
import { WorldScaleControl } from "./components/WorldScaleControl";
import { LocationList } from "./components/LocationList";
import { LocationInspector } from "./components/LocationInspector";
import { RouteInspector } from "./components/RouteInspector";
import { CommoditiesPanel } from "./components/CommoditiesPanel";
import { CompaniesPanel } from "./components/CompaniesPanel";
import { PoliticalEntitiesPanel } from "./components/PoliticalEntitiesPanel";
import { worldToJson, parseWorldJson, downloadJson } from "./worldJson";
import "./App.css";

function App() {
  const worldScale = useEditorStore((s) => s.worldScale);
  const politicalEntities = useEditorStore((s) => s.politicalEntities);
  const locations = useEditorStore((s) => s.locations);
  const commodities = useEditorStore((s) => s.commodities);
  const companies = useEditorStore((s) => s.companies);
  const routes = useEditorStore((s) => s.routes);
  const loadWorld = useEditorStore((s) => s.loadWorld);
  const selectedRouteId = useEditorStore((s) => s.selectedRouteId);
  const backgroundImage = useEditorStore((s) => s.backgroundImage);
  const setBackgroundImage = useEditorStore((s) => s.setBackgroundImage);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const isEmpty =
    locations.length === 0 && commodities.length === 0 && companies.length === 0 && politicalEntities.length === 0;

  function currentWorldJson(): string {
    return worldToJson({ worldScale, politicalEntities, locations, commodities, companies, routes });
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

  function handleBackgroundFile(file: File) {
    if (!file.type.startsWith("image/")) {
      window.alert("Please choose an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBackgroundImage(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => window.alert("Could not read the image file.");
    reader.readAsDataURL(file);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>World Editor</h1>
        <WorldScaleControl />
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
        <button type="button" onClick={() => backgroundInputRef.current?.click()}>
          {backgroundImage !== null ? "Change background" : "Set background"}
        </button>
        {backgroundImage !== null && (
          <button type="button" onClick={() => setBackgroundImage(null)}>
            Clear background
          </button>
        )}
        <input
          ref={backgroundInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleBackgroundFile(file);
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
          {/* A Route and a Location are mutually exclusive selections (see the
              store's selectRoute/selectLocation), so show whichever inspector
              matches the current selection. */}
          {selectedRouteId !== null ? <RouteInspector /> : <LocationInspector />}
        </aside>
      </div>
    </div>
  );
}

export default App;
