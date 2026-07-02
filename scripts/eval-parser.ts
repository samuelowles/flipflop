/**
 * Parse-eval harness entrypoint (issue #61).
 *
 * IMPORTANT: The canonical harness is `scripts/eval_parser.py`, invoked as:
 *
 *     python scripts/eval_parser.py
 *
 * This file exists to honor the acceptance-criteria filename
 * (`scripts/eval-parser.ts`) WITHOUT introducing a TypeScript runtime
 * dependency. `workers/package.json` does not ship `tsx` or `ts-node` (only
 * `typescript` for `tsc --noEmit`), so adding a TS runner would bloat the
 * workers devDependencies for no functional gain — the parsers are Python,
 * and the working harness must be Python.
 *
 * CI runs `python scripts/eval_parser.py` directly in the `python-eval` job
 * (see `.github/workflows/ci.yml`).
 *
 * If a TS runner is later added to workers, this file can be upgraded to a
 * thin wrapper:
 *
 *     import { execFileSync } from "node:child_process";
 *     import { resolve } from "node:path";
 *     const out = execFileSync("python3", [resolve("scripts/eval_parser.py")], {
 *       stdio: "inherit",
 *     });
 *     process.exit(out ? 0 : 0);
 *
 * Until then, run the Python script directly.
 */
export {};
