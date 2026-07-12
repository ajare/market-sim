import { useSimStore } from "../state/useSimStore";

export function EventsPanel() {
  const world = useSimStore((s) => s.world);
  const day = useSimStore((s) => s.day);
  if (world === null) return null;

  return (
    <div className="panel events-panel">
      <h2>Events</h2>
      {world.eventLog.length === 0 ? (
        <p className="muted">No events yet -- step the simulation.</p>
      ) : (
        <div className="scroll-table">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Type</th>
                <th>Scope</th>
                <th>Subject</th>
                <th>Event</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {[...world.eventLog]
                .sort((a, b) => (b.day ?? 0) - (a.day ?? 0))
                .map((event, i) => {
                  // An event's window is [day, day + duration) -- matches the
                  // tick()-based active-tracking elsewhere (activeBroadEvents,
                  // closedLocations, activeAgentEvents), computed directly
                  // from day/duration rather than relying on whichever active
                  // list happens to still hold this same object reference.
                  const isActive = event.day !== null && day - event.day < event.duration;
                  return (
                    <tr key={i} className={isActive ? undefined : "muted"}>
                      <td>{event.day ?? "-"}</td>
                      <td>{event.type}</td>
                      <td>{event.scope}</td>
                      <td>{event.subject || <span className="muted">-</span>}</td>
                      <td>{event.message}</td>
                      <td>{event.duration}d</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
