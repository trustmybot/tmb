import plannerRole from "../../roles/planner.md" with { type: "text" };

/** A host-neutral event, raised by a host adapter. */
export type EngineEvent = { type: "session-start" };

export type EngineAnswer = { context: string };

export function handleEvent(event: EngineEvent): EngineAnswer {
  switch (event.type) {
    case "session-start":
      return { context: plannerRole };
  }
}

export { plannerRole };
