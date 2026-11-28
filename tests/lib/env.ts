// Environment variables a test sets for itself: setEnv changes one and remembers what it was, and
// restoreEnv, called from afterEach, puts every one back.
const saved: Record<string, string | undefined> = {};

/** Sets an environment variable for one test; restoreEnv puts it back. */
export function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

/** The value a variable had before this test's first setEnv of it. */
export function savedEnv(name: string): string | undefined {
  return name in saved ? saved[name] : process.env[name];
}

/** Puts back every variable setEnv changed. */
export function restoreEnv(): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
}

/** Whether this test has already set the variable with setEnv. */
export function envChanged(name: string): boolean {
  return name in saved;
}
