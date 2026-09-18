import { createActor, type AnyStateMachine } from "xstate";

/**
 * Thrown when a state machine rejects an event from the current state.
 * Callers catch this and convert to HTTP/service errors.
 */
export class WorkflowTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly event: string,
    public readonly machineId: string,
    detail?: string,
  ) {
    const suffix = detail ? ` (${detail})` : "";
    super(`[${machineId}] Cannot apply '${event}' in state '${from}'${suffix}`);
    this.name = "WorkflowTransitionError";
  }
}

/**
 * Returns invariant helpers bound to a specific machine.
 *
 * Use for machines with guards + context (receipt, disbursement).
 * Simple context-free machines only need WorkflowTransitionError.
 *
 * Usage:
 *   const { assertLegalTransition, assertExpectedState, isTerminalState } =
 *     makeWorkflowInvariants<MyContext, MyEvent>(myMachine);
 */
export function makeWorkflowInvariants<
  TContext extends object,
  TEvent extends { type: string },
>(machine: AnyStateMachine) {
  const machineId = machine.id;

  function evalTransition(currentState: string, event: TEvent, context: TContext): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = machine.resolveState({ value: currentState, context } as any);
    const actor = createActor(machine, { snapshot });
    actor.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actor.send(event as any);
    const next = String(actor.getSnapshot().value);
    actor.stop();
    return next;
  }

  /**
   * Assert that sending `event` from `currentState` is a legal transition.
   * Throws WorkflowTransitionError if the machine has no handler.
   * Call BEFORE executing service logic — validates intent.
   */
  function assertLegalTransition(
    currentState: string,
    event: TEvent,
    context: TContext,
  ): void {
    const next = evalTransition(currentState, event, context);
    if (next === currentState) {
      const { type, ...rest } = event;
      const detail = Object.keys(rest).length
        ? Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(", ")
        : undefined;
      throw new WorkflowTransitionError(currentState, type, machineId, detail);
    }
  }

  /**
   * Assert that the machine agrees with the state the service is about to persist.
   * Throws on divergence. Call AFTER computing nextState, BEFORE writing to DB.
   */
  function assertExpectedState(
    currentState: string,
    event: TEvent,
    context: TContext,
    expectedNext: string,
  ): void {
    const next = evalTransition(currentState, event, context);
    if (next !== expectedNext) {
      const msg = `${machineId} state divergence: machine→${next}, service→${expectedNext} (from ${currentState} + ${event.type})`;
      console.error(msg, { currentState, eventType: event.type, machineNext: next, serviceNext: expectedNext });
      throw new Error(msg);
    }
  }

  /**
   * Topology-only check: does `state` have any handler for `eventType`?
   * Does not evaluate guards — answers "is this event defined for this state?".
   */
  function isLegalTransition(currentState: string, eventType: string): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stateConfig = (machine.config.states as Record<string, any>)?.[currentState];
    if (!stateConfig?.on) return false;
    return eventType in stateConfig.on;
  }

  /**
   * Returns event types defined for the given state (guard-blind).
   */
  function legalEventTypes(state: string): string[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stateConfig = (machine.config.states as Record<string, any>)?.[state];
    if (!stateConfig?.on) return [];
    return Object.keys(stateConfig.on);
  }

  /**
   * Returns true if `state` has no outbound transitions.
   */
  function isTerminalState(state: string): boolean {
    return legalEventTypes(state).length === 0;
  }

  return {
    resolveNextState: evalTransition,
    assertLegalTransition,
    assertExpectedState,
    isLegalTransition,
    legalEventTypes,
    isTerminalState,
  };
}
