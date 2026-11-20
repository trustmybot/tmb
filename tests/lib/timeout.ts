// Loaded before every test file (bunfig.toml): one timeout for every test and hook, in place of
// bun's 5 seconds. Many tests start tmb, git or a server, and on a busy machine (several suites at
// once, a build running) those take longer than 5 seconds without anything being wrong
// (trustmybot/tmb#196). 30 seconds leaves that room, and a test that really hangs still fails
// within it. A test that needs more names its own timeout, as the update and review-mark tests do.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
