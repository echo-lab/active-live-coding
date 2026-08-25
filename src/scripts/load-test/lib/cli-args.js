// Minimal `--flag value` / `--boolean-flag` parser -- shared across the load-test scripts so
// each one doesn't hand-roll its own argv loop.
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

export const DEFAULT_SERVER_URL = process.env.LOAD_TEST_SERVER_URL ?? "http://localhost:3000";
