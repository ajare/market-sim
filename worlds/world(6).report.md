# World tuning report: world(6).json

Run over 90 days (first 30 excluded as warmup), averaged across 3 seeds (1, 2, 3), with 20 pirate ship(s) and 80 police ship(s) added. Ratio guardrail band: 1.0 +/- 0.15.

## Metrics by stage

| Stage | Zero-stock pairs | Avg. outage length (days) | Avg. stockpile/minimum ratio |
| --- | --- | --- | --- |
| Baseline | 16.000 | 3.008 | 0.969 |
| After Stage 0 (world-wide commodity balance) | 16.333 | 2.759 | 1.054 |
| After Stage 1 (consumption modifiers) | 11.667 | 2.369 | 1.079 |
| After Stage 2 (ships per Location) | 11.667 | 2.369 | 1.079 |
| After Stage 3 (commodity-Location swaps) | 8.000 | 3.005 | 1.108 |
| After Stage 4 (added producers for remaining shortages) | 3.000 | 2.411 | 1.264 |

## Stage 0: world-wide commodity balance

Added a first-ever consumer for 1 commodity that were produced but never consumed anywhere (unsellable otherwise):

| Commodity | New consumer | Nearest producer |
| --- | --- | --- |
| Gunpowder | Fort-de-France | Espírito Santo |

Rescaled 20 commodities' produced/consumed modifiers toward the midpoint of world-wide total production and consumption:

| Commodity | Produced/day (before) | Consumed/day (before) | Produced/day (after) | Consumed/day (after) |
| --- | --- | --- | --- | --- |
| Rice | 28.00 | 28.00 | 28.00 | 28.00 |
| Pimento | 28.00 | 28.00 | 28.00 | 28.00 |
| Gunpowder | 24.00 | 0.00 | 16.00 | 16.00 |
| Rum | 16.00 | 16.00 | 16.00 | 16.00 |
| Gold | 16.00 | 16.00 | 16.00 | 16.00 |
| Molasses | 16.00 | 16.00 | 16.00 | 16.00 |
| Coffee | 12.00 | 12.00 | 12.00 | 12.00 |
| Tobacco | 12.00 | 12.00 | 12.00 | 12.00 |
| Pearls | 24.00 | 24.00 | 24.00 | 24.00 |
| Silver | 24.00 | 24.00 | 24.00 | 24.00 |
| Logwood | 12.00 | 12.00 | 12.00 | 12.00 |
| Mahogany | 20.00 | 19.67 | 19.83 | 19.83 |
| Cochineal | 16.00 | 16.00 | 16.00 | 16.00 |
| Tortoiseshell | 8.00 | 8.00 | 8.00 | 8.00 |
| Salt | 12.00 | 12.00 | 12.00 | 12.00 |
| Indigo | 20.00 | 20.00 | 20.00 | 20.00 |
| Ginger | 16.00 | 16.00 | 16.00 | 16.00 |
| Sugar | 16.00 | 16.00 | 16.00 | 16.00 |
| Cacao | 16.00 | 16.00 | 16.00 | 16.00 |
| Cotton | 16.00 | 16.00 | 16.00 | 16.00 |

## Stage 1: consumption-modifier changes

| Location | Commodity | From | To |
| --- | --- | --- | --- |
| Port Royal | Molasses | 1.000 | 0.780 |
| Nombre de Dios | Sugar | 1.000 | 0.720 |
| São Salvador | Mahogany | 0.798 | 0.778 |
| Fort-de-France | Mahogany | 0.840 | 0.672 |
| Charlestown | Cochineal | 0.667 | 0.650 |

## Stage 2: ships-per-Location ratio

No improvement found -- kept at 5 ships per Location.

## Stage 3: commodity-Location swaps

| Commodity | Moved from | Moved to | In exchange for |
| --- | --- | --- | --- |
| Molasses | Louisbourg | Willemstad | Pearls |
| Mahogany | Nieuw Oranje | Espírito Santo | Gunpowder |
| Ginger | São Salvador | Louisbourg | Cochineal |
| Ginger | Louisbourg | Espírito Santo | Rice |
| Indigo | New Plymouth | Nieuw Middelburg | Pimento |
| Rice | Louisbourg | Nieuw Oranje | Gunpowder |
| Sugar | Montréal | Fort Kijkoveral | Coffee |
| Coffee | Montréal | Espírito Santo | Ginger |

## Stage 4: added producers for remaining shortages

| Commodity | Consumer (shortage) | New producer | Producer modifier | Rebalanced against |
| --- | --- | --- | --- | --- |
| Ginger | Saint-Pierre | Espírito Santo | 1.0001 | Montréal |
| Rice | New Plymouth | Nombre de Dios | 0.5833 | Portobelo, New Providence, Fort-Royal, Nieuw Oranje, Willemstad |
| Coffee | Charlestown | Nombre de Dios | 0.7500 | Espírito Santo |
| Ginger | Nombre de Dios | Charlestown | 0.6667 | Montréal, Espírito Santo |
| Cacao | Nieuw Oranje | New Providence | 1.0001 | São Salvador |
| Rice | Charlestown | San Agustín | 0.5000 | Portobelo, New Providence, Fort-Royal, Nombre de Dios, Nieuw Oranje, Willemstad |
| Rum | Montréal | Fort-Royal | 0.6667 | Fort Kijkoveral, Port Royal |
| Rum | Belém | Louisbourg | 0.5000 | Fort Kijkoveral, Port Royal, Fort-Royal |
| Indigo | Nombre de Dios | Charlestown | 0.8333 | Montréal, Nieuw Middelburg |
| Salt | New Providence | Nieuw Oranje | 0.7500 | Nombre de Dios |
| Pearls | Saint-Pierre | Espírito Santo | 0.5000 | Fort Kijkoveral, Fort-Royal, Louisbourg, Fort-de-France, Nieuw Middelburg |
| Indigo | Santo Domingo | Fort-de-France | 0.6250 | Montréal, Charlestown, Nieuw Middelburg |

## Output files

- Tuned World JSON: `world(6).tuned.json`
- Unified diff: `world(6).tuned.diff` (apply with `git apply` or `patch -p0`)
