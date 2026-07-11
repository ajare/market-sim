/** Mirrors load_locations_csv/load_commodities_csv's expected columns (sim/csv_loaders.py). */
import type { Commodity, EditorLocation } from "./types";

function mapToPairs(map: Record<string, number>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function locationsToCsv(locations: EditorLocation[]): string {
  const header = [
    "name", "x", "y", "produced_commodities", "consumed_commodities",
    "stockpiles", "min_stockpiles", "base_prices", "fuel_price", "terminal_types",
  ];
  const rows = locations.map((loc) =>
    [
      loc.name,
      String(loc.x),
      String(loc.y),
      mapToPairs(loc.producedCommodities),
      mapToPairs(loc.consumedCommodities),
      mapToPairs(loc.stockpiles),
      mapToPairs(loc.minStockpiles),
      mapToPairs(loc.basePriceModifiers),
      String(loc.fuelPrice),
      loc.terminalTypes.join(";"),
    ]
      .map(csvField)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function commoditiesToCsv(commodities: Commodity[]): string {
  const header = ["name", "base_price", "production_rate", "consumption_rate"];
  const rows = commodities.map((c) =>
    [c.name, String(c.basePrice), String(c.productionRate), String(c.consumptionRate)].map(csvField).join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
