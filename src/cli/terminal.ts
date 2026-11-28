// The terminal a person answers questions on.
import { createInterface, type Interface } from "node:readline";

/** Shows a prompt and reads one line; null once input has ended. */
export type Ask = (prompt: string) => Promise<string | null>;

/** Asks on a terminal, one line per question, until closed. */
export class TerminalPrompt {
  private readonly lines: Interface;
  private readonly next: AsyncIterator<string>;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.lines = createInterface({ input, output, terminal: true });
    this.next = this.lines[Symbol.asyncIterator]();
  }

  readonly ask: Ask = async (prompt) => {
    this.lines.setPrompt(prompt);
    this.lines.prompt();
    const line = await this.next.next();
    return line.done ? null : line.value;
  };

  close(): void {
    this.lines.close();
  }
}
