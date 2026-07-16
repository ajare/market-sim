import { useSimStore } from "../state/useSimStore";

/**
 * The first modal in the app -- a blocking overlay with a backdrop, shown
 * whenever World.pendingDecision is set (see World.runDay's pause gate).
 * Renders every eligible Choice as a button; picking one resolves the
 * decision and lets the simulation resume. Deliberately a new UI pattern
 * (not the existing inline-panel/popup style) -- a decision that halts the
 * whole simulation needs a correspondingly strong attention signal, per
 * doc/ExploreGameIntegration.md's "Event-driven decisions" section.
 */
export function DecisionModal() {
  const world = useSimStore((s) => s.world);
  // `version` isn't read directly, but subscribing forces a re-render when
  // World.pendingDecision is set/cleared in place (world mutates in place --
  // see useSimStore.ts's own doc comment).
  useSimStore((s) => s.version);
  const resolveDecision = useSimStore((s) => s.resolveDecision);

  const decision = world?.pendingDecision ?? null;
  if (decision === null) return null;

  const explorer = decision.explorer;
  const eligibleChoices = decision.choices.filter((choice) => choice.isEligible({ explorer }));

  return (
    <div className="decision-modal-backdrop">
      <div className="decision-modal">
        <h2>{decision.title}</h2>
        <p>{decision.description}</p>
        <div className="decision-modal-choices">
          {eligibleChoices.map((choice, i) => (
            <button key={i} type="button" onClick={() => resolveDecision(choice)}>
              <span className="decision-choice-label">{choice.label}</span>
              <span className="decision-choice-hint muted">{choice.riskHint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
