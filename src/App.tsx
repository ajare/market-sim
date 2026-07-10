import { useSimStore } from "./state/useSimStore";
import { useSimLoop } from "./state/useSimLoop";
import { ControlsPanel } from "./components/ControlsPanel";
import { LocationsPanel } from "./components/LocationsPanel";
import { FleetPanel } from "./components/FleetPanel";
import { ContractsPanel } from "./components/ContractsPanel";
import { StockHistoryPanel } from "./components/StockHistoryPanel";
import { PriceHistoryPanel } from "./components/PriceHistoryPanel";
import { NetWorthHistoryPanel } from "./components/NetWorthHistoryPanel";
import { NetworkView } from "./components/NetworkView";
import { EventsPanel } from "./components/EventsPanel";
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
      <EventsPanel />
      <StockHistoryPanel />
      <PriceHistoryPanel />
      <NetWorthHistoryPanel />
      <div className="panels">
        <LocationsPanel />
        <FleetPanel />
        <ContractsPanel />
      </div>
    </div>
  );
}

export default App;
