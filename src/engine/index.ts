import { sessionStartContext } from "./session-start.ts";

/** A host-neutral event, raised by a host adapter. */
export type EngineEvent = { type: "session-start"; projectDir: string };

export type EngineAnswer = { context: string };

export function handleEvent(event: EngineEvent): EngineAnswer {
  switch (event.type) {
    case "session-start":
      return { context: sessionStartContext(event.projectDir) };
  }
}

export { OPEN_WORK_HEADING, OPEN_WORK_MAX, plannerRole } from "./session-start.ts";
export { openProjectStore, PROJECT_DIR_NAME, projectDbPath } from "./project.ts";
