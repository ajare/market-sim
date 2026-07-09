import { useSimStore } from "./state/useSimStore";
import { useSimLoop } from "./state/useSimLoop";
import { ControlsPanel } from "./components/ControlsPanel";
import { LocationsPanel } from "./components/LocationsPanel";
import { FleetPanel } from "./components/FleetPanel";
import { NetworkView } from "./components/NetworkView";
import "./App.css";

function App() {
  useSimLoop();
  // Subscribing to `version` forces a re-render every time World.step()
  // mutates the world in place -- see useSimStore.ts's doc comment.
  useSimStore((s) => s.version);

  return (
    <div className="app">
      <h1>Commodity Sim</h1>
      <ControlsPanel />
      <NetworkView />
      <div className="panels">
        <LocationsPanel />
        <FleetPanel />
      </div>
    </div>
  );
}

export default App;
