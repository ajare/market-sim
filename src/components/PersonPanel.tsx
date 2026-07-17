import { useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { Sailor } from "../sim/sailor";
import { Captain } from "../sim/captain";
import { ageInYears, type Person } from "../sim/person";
import { getSailorPoolAt } from "../sim/sailorPool";
import type { World } from "../sim/world";

/** Every Person in the World right now: every Transport's full crew (Captain + Sailors, aboard) plus every Location's Sailor pool (idle, not yet hired -- see sailorPool.ts). */
function allPersons(world: World): Person[] {
  const aboard = world.shipCaptains.flatMap((c) => c.transport?.crew ?? []);
  const pooled = world.locations.flatMap((loc) => getSailorPoolAt(loc.name));
  return [...aboard, ...pooled];
}

/** Every roster-table column, as a plain string -- lets filtering/sorting treat every column uniformly (a lexicographic string sort/filter, including Age, per this panel's own convention) regardless of the underlying field's real type. */
interface PersonRow {
  person: Person;
  name: string;
  nickname: string;
  gender: string;
  nationality: string;
  age: string;
  rank: string;
  location: string;
  aboard: string;
}

function toRow(person: Person, world: World): PersonRow {
  return {
    person,
    name: person.name,
    nickname: person.nickname ?? "-",
    gender: person.gender,
    nationality: person.nationality ?? "-",
    age: String(ageInYears(person.dateOfBirth, world.currentDate)),
    rank: person instanceof Sailor ? person.rank : "-",
    location: person.currentLocation()?.name ?? "-",
    aboard: person.transport?.name ?? "-",
  };
}

type ColumnKey = Exclude<keyof PersonRow, "person">;

/** Every roster column, in display order -- `filterable` drives whether it gets a dropdown in the filter row. Every column (filterable or not) is sortable by clicking its header. */
const COLUMNS: Array<{ key: ColumnKey; label: string; filterable: boolean }> = [
  { key: "name", label: "Name", filterable: false },
  { key: "nickname", label: "Nickname", filterable: false },
  { key: "gender", label: "Gender", filterable: true },
  { key: "nationality", label: "Nationality", filterable: true },
  { key: "age", label: "Age", filterable: false },
  { key: "rank", label: "Rank", filterable: true },
  { key: "location", label: "Location", filterable: true },
  { key: "aboard", label: "Aboard", filterable: true },
];

const ALL_FILTER = "All";

/** Every distinct value `key` takes across `rows`, sorted -- the options offered in that column's filter dropdown. Computed off the FULL row set (not the already-filtered one), so narrowing one filter never hides options for another. */
function uniqueOptions(rows: PersonRow[], key: ColumnKey): string[] {
  return [...new Set(rows.map((row) => row[key]))].sort((a, b) => a.localeCompare(b));
}

/**
 * Lists every Person in the World -- not just whoever's currently selected --
 * aboard any Transport or sitting idle in any Location's Sailor pool.
 * Gender/Nationality/Rank/Location/Aboard are filterable via a per-column
 * dropdown; every column sorts lexicographically on header click (asc -> desc
 * -> unsorted). Clicking a row (or a name in TransportsPanel/FleetPanel,
 * which share the same selectedPerson state) expands the full-detail section
 * below the table: a plain Sailor's name/rank/pool status, or a Captain's
 * trading-agent fields too.
 */
export function PersonPanel() {
  const world = useSimStore((s) => s.world);
  const selectedPerson = useSimStore((s) => s.selectedPerson);
  const selectPerson = useSimStore((s) => s.selectPerson);
  const [filters, setFilters] = useState<Partial<Record<ColumnKey, string>>>({});
  const [sort, setSort] = useState<{ key: ColumnKey; direction: "asc" | "desc" } | null>(null);
  if (world === null) return null;

  // Not memoized -- World/Captain/Location mutate in place (see
  // useSimStore.ts's doc comment), so every render re-derives rows straight
  // off live objects rather than risking a stale memoized snapshot.
  const rows = allPersons(world).map((person) => toRow(person, world));

  const filteredRows = rows.filter((row) =>
    COLUMNS.every((col) => {
      const chosen = filters[col.key];
      return !col.filterable || chosen === undefined || chosen === ALL_FILTER || row[col.key] === chosen;
    }),
  );
  const sortedRows =
    sort === null
      ? filteredRows
      : [...filteredRows].sort((a, b) => {
          // Every column sorts lexicographically except Age, which sorts
          // numerically (so "9" comes before "10") -- everything else is a
          // free-text/enum string where lexicographic order is what a user
          // scanning the column actually expects.
          const cmp =
            sort.key === "age" ? Number(a.age) - Number(b.age) : a[sort.key].localeCompare(b[sort.key]);
          return sort.direction === "asc" ? cmp : -cmp;
        });

  function toggleSort(key: ColumnKey): void {
    setSort((prev) => {
      if (prev === null || prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  }

  // Captain extends Sailor extends Person -- narrow both independently so a
  // plain Sailor still gets its rank/rotation row without also matching the
  // Captain-only section below.
  const sailor = selectedPerson instanceof Sailor ? selectedPerson : null;
  const captain = selectedPerson instanceof Captain ? selectedPerson : null;

  return (
    <div className="panel person-panel">
      <h2>Persons</h2>
      {rows.length === 0 ? (
        <p className="muted">No Persons in this World.</p>
      ) : (
        <div className="scroll-table">
          <table className="person-list-table">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="sortable-header" onClick={() => toggleSort(col.key)}>
                    {col.label}
                    {sort?.key === col.key ? (sort.direction === "asc" ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
              <tr className="person-filter-row">
                {COLUMNS.map((col) => (
                  <th key={col.key}>
                    {col.filterable && (
                      <select
                        value={filters[col.key] ?? ALL_FILTER}
                        onChange={(e) => setFilters((f) => ({ ...f, [col.key]: e.target.value }))}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value={ALL_FILTER}>All</option>
                        {uniqueOptions(rows, col.key).map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="muted">
                    No Persons match the selected filters.
                  </td>
                </tr>
              ) : (
                sortedRows.map((row, i) => (
                  // Names aren't unique across the World, so key by index --
                  // same rationale as FleetPanel/TransportsPanel's rows.
                  <tr
                    key={i}
                    className={row.person === selectedPerson ? "fleet-row-selected" : undefined}
                    onClick={() => selectPerson(row.person)}
                  >
                    <td>{row.name}</td>
                    <td>{row.nickname}</td>
                    <td>{row.gender}</td>
                    <td>{row.nationality}</td>
                    <td>{row.age}</td>
                    <td>{row.rank}</td>
                    <td>{row.location}</td>
                    <td>{row.aboard}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectedPerson === null ? (
        <p className="muted">Select a row above (or a name in the Fleet / Transports panel) to see full details.</p>
      ) : (
        <>
          <div className="person-panel-header">
            <h3>{selectedPerson.name}</h3>
            <button type="button" onClick={() => selectPerson(null)}>
              Close
            </button>
          </div>
          <table className="person-details-table">
            <tbody>
              <tr>
                <th>Name</th>
                <td>{selectedPerson.name}</td>
              </tr>
              <tr>
                <th>Nickname</th>
                <td>{selectedPerson.nickname ?? "-"}</td>
              </tr>
              <tr>
                <th>Gender</th>
                <td>{selectedPerson.gender}</td>
              </tr>
              <tr>
                <th>Nationality</th>
                <td>{selectedPerson.nationality ?? "-"}</td>
              </tr>
              <tr>
                <th>Date of birth</th>
                <td>{selectedPerson.dateOfBirth.toLocaleDateString()}</td>
              </tr>
              <tr>
                <th>Age</th>
                <td>{ageInYears(selectedPerson.dateOfBirth, world.currentDate)}</td>
              </tr>
              <tr>
                <th>Daily wage</th>
                <td>${selectedPerson.dailyWage.toFixed(2)}</td>
              </tr>
              <tr>
                <th>Current location</th>
                <td>{selectedPerson.currentLocation()?.name ?? "-"}</td>
              </tr>
              <tr>
                <th>Aboard</th>
                <td>{selectedPerson.transport?.name ?? "-"}</td>
              </tr>
              {sailor !== null && (
                <>
                  <tr>
                    <th>Rank</th>
                    <td>{sailor.rank}</td>
                  </tr>
                  <tr>
                    <th>Journeys remaining</th>
                    <td>{sailor.journeysRemaining ?? "Permanent"}</td>
                  </tr>
                </>
              )}
              {captain !== null && (
                <>
                  <tr>
                    <th>Company</th>
                    <td>{captain.company?.name ?? "(independent)"}</td>
                  </tr>
                  <tr>
                    <th>Political entity</th>
                    <td>{captain.company?.politicalEntity?.name ?? "Independent"}</td>
                  </tr>
                  <tr>
                    <th>Status</th>
                    {/* A benched (sank in port) or dead (sank at sea) Captain has no Transport left -- captain.status reads it unconditionally, so guard here rather than let a stale selection crash the render. */}
                    <td>{captain.transport !== null ? captain.status : "Lost ship"}</td>
                  </tr>
                  <tr>
                    <th>Cash</th>
                    <td>${captain.cash.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <th>Destination</th>
                    <td>{captain.destination ?? "-"}</td>
                  </tr>
                  <tr>
                    <th>Days remaining</th>
                    <td>{captain.destination !== null ? captain.daysRemaining : "-"}</td>
                  </tr>
                  <tr>
                    <th>Cargo</th>
                    <td>
                      {captain.cargo !== null
                        ? `${captain.cargo.items.map((item) => `${item.quantity.toFixed(1)} ${item.commodity}`).join(", ")} → ${captain.cargo.destination}`
                        : "-"}
                    </td>
                  </tr>
                  <tr>
                    <th>Realized profit</th>
                    <td>${captain.realizedProfit.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <th>Total fuel spent</th>
                    <td>${captain.totalFuelSpent.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <th>Total repositions</th>
                    <td>{captain.totalRepositions}</td>
                  </tr>
                  <tr>
                    <th>Grounded days remaining</th>
                    <td>{captain.groundedDaysRemaining}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          {captain !== null && captain.shipLog.length > 0 && (
            <>
              <h3>Ship's Log</h3>
              <ul className="ship-log">
                {captain.shipLog
                  .slice(-30)
                  .reverse()
                  .map((entry) => (
                    <li key={entry.day} className="ship-log-entry">
                      <span className="ship-log-day">Day {entry.day}.</span>
                      {entry.text}
                    </li>
                  ))}
              </ul>
            </>
          )}
          {captain !== null && captain.tradeLog.length > 0 && (
            <>
              <h3>Recent trades</h3>
              <div className="scroll-table">
                <table>
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Action</th>
                      <th>Commodity</th>
                      <th>Location</th>
                      <th>Quantity</th>
                      <th>Price</th>
                      <th>Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {captain.tradeLog
                      .slice(-10)
                      .reverse()
                      .map((entry, i) => (
                        <tr key={i}>
                          <td>{entry.day}</td>
                          <td>{entry.action}</td>
                          <td>{entry.commodity ?? "-"}</td>
                          <td>{entry.location}</td>
                          <td>{entry.quantity.toFixed(1)}</td>
                          <td>{entry.price !== null ? `$${entry.price.toFixed(2)}` : "-"}</td>
                          <td>{entry.profit !== null ? `$${entry.profit.toFixed(2)}` : "-"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
