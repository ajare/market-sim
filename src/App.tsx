import { useSimStore } from "./state/useSimStore";
import { useSimLoop } from "./state/useSimLoop";
import { ControlsPanel } from "./components/ControlsPanel";
import { PoliticalEntitiesPanel } from "./components/PoliticalEntitiesPanel";
import { LocationsPanel } from "./components/LocationsPanel";
import { FleetPanel } from "./components/FleetPanel";
import { BuyShipPanel } from "./components/BuyShipPanel";
import { TransportsPanel } from "./components/TransportsPanel";
import { PersonPanel } from "./components/PersonPanel";
import { ContractsPanel } from "./components/ContractsPanel";
import { StockHistoryPanel } from "./components/StockHistoryPanel";
import { PriceHistoryPanel } from "./components/PriceHistoryPanel";
import { NetWorthHistoryPanel } from "./components/NetWorthHistoryPanel";
import { TransportConditionHistoryPanel } from "./components/TransportConditionHistoryPanel";
import { WeatherClimatePanel } from "./components/WeatherClimatePanel";
import { NetworkView } from "./components/NetworkView";
import { TransportHeatmapPanel } from "./components/TransportHeatmapPanel";
import { StockLevelHeatmapPanel } from "./components/StockLevelHeatmapPanel";
import { PirateAttackHeatmapPanel } from "./components/PirateAttackHeatmapPanel";
import { EventsPanel } from "./components/EventsPanel";
import { ExplorerPanel } from "./components/ExplorerPanel";
import { DecisionModal } from "./components/DecisionModal";
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
      <WeatherClimatePanel />
      <TransportHeatmapPanel />
      <PirateAttackHeatmapPanel />
      <EventsPanel />
      <StockLevelHeatmapPanel />
      <StockHistoryPanel />
      <PriceHistoryPanel />
      <NetWorthHistoryPanel />
      <TransportConditionHistoryPanel />
      <div className="panels">
        <PoliticalEntitiesPanel />
        <LocationsPanel />
        <FleetPanel />
        <BuyShipPanel />
        <TransportsPanel />
        <PersonPanel />
        <ContractsPanel />
        <ExplorerPanel />
      </div>
      <DecisionModal />
    </div>
  );
}

export default App;
