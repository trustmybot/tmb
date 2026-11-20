// Runs one command on a pseudo-terminal, as the Human at their own terminal, and types the answer
// to each question it asks, in order (trustmybot/tmb#179). A step only the Human may take runs
// only on a terminal, so a test that takes such a step as the Human runs it through here.
//
//   bun tests/lib/human-terminal.ts <answers-json> <program> [args...]
//
// <answers-json> is a JSON list of the lines to type, one per question: a question is the text
// the command writes and then waits on. What the terminal showed goes to stdout, with \r\n as \n;
// the exit code is the command's.
export {};

const [answersJson, program, ...args] = process.argv.slice(2);
if (answersJson === undefined || program === undefined) {
  process.stderr.write("usage: bun tests/lib/human-terminal.ts <answers-json> <program> [args...]\n");
  process.exit(2);
}
const answers = JSON.parse(answersJson) as string[];

let shown = "";
/** What the terminal shows as text: the escape codes that move the cursor or clear a line are left out. */
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n");
let typedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const child = Bun.spawn([program, ...args], {
  cwd: process.cwd(),
  env: process.env,
  terminal: {
    cols: 200,
    rows: 50,
    data(terminal, data) {
      shown += new TextDecoder().decode(data);
      // A question ends in ": " with nothing after it; answer once the output settles there.
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        if (answers.length === 0 || !/: $/.test(plain(shown)) || shown.length === typedAt) return;
        typedAt = shown.length;
        terminal.write(`${answers.shift()}\r`);
      }, 150);
    },
  },
});

const code = await Promise.race([child.exited, Bun.sleep(60_000).then(() => null)]);
if (timer !== undefined) clearTimeout(timer);
if (code === null) {
  child.kill();
  process.stdout.write(plain(shown));
  process.stderr.write("human-terminal: the command did not finish within 60 seconds\n");
  process.exit(124);
}
child.terminal?.close();
process.stdout.write(plain(shown));
process.exit(code);
