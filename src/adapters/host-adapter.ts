/** What every host adapter gives the command line. */
export interface HostAdapter {
  /** The host's display name. */
  name: string;
  /** Wires the host to the given tmb executable in the project; returns what changed, one line each. */
  setup(projectDir: string, executablePath: string): string[];
  /** Undoes exactly what setup added; returns what changed, one line each. */
  remove(projectDir: string): string[];
  /** Answers a host event: the host's stdin in, the host's stdout out. Throws on bad input. */
  answerHook(event: string, stdinText: string): string;
}
