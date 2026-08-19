#!/usr/bin/env node
// One-off: fix the CRLF churn that makes every diff in this repo unreadable.
//
// 607 paths currently show as modified. Sampling shows the diffs are whole-file
// line-ending flips with zero content change — caused by editing on Windows
// under a Dropbox-synced path with no normalisation rule.
//
// Until this is fixed, `git diff` is useless, which means the review node of
// the engine cannot function. This is the first thing that must land.
//
// Run once, from the repo root, on a clean checkout of master:
//   node engine/normalise-line-endings.mjs
//   node engine/normalise-line-endings.mjs --apply

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const RULE = `# Normalise line endings. Without this, editing on Windows under a synced
# folder rewrites whole files and every diff becomes unreadable.
* text=auto eol=lf

# Binary — never touch. core.autocrlf was CRLF-smudging fixture PDFs on Windows
# checkout and corrupting them (xref offsets shift).
*.pdf   binary
*.png   binary
*.jpg   binary
*.jpeg  binary
*.gif   binary
*.ico   binary
*.zip   binary
*.db    binary
*.sqlite binary

# Keep shell scripts LF regardless of platform.
*.sh    text eol=lf
*.mjs   text eol=lf
`;

const branch = sh("git branch --show-current");
if (branch !== "master") {
  console.error(`\n  Refusing to run on '${branch}'. Check out master first.\n`);
  process.exit(1);
}

const dirty = sh("git status --porcelain").split("\n").filter(Boolean);
const real = dirty.filter((l) => !/^\?\?/.test(l));

console.log(`\n  Line-ending normalisation\n`);
console.log(`  dirty paths          ${dirty.length}`);
console.log(`  tracked modified     ${real.length}`);

// Prove the churn is line-endings only before touching anything.
//
// This MUST examine every file, not a sample. An earlier version sampled the
// first 40 and would have silently discarded ~94 lines of genuine in-progress
// work in workers/src/services/powerswitchSession.ts, which sorts late.
//
// --numstat honours --ignore-cr-at-eol (--name-only does not), so one call
// gives the true list: any file with a non-zero add or delete count has real
// content changes.
const numstat = sh("git diff --ignore-cr-at-eol --numstat")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"));

const contentChanged = numstat
  .filter(([add, del]) => add !== "0" || del !== "0")
  .filter(([add]) => add !== "-")            // binary; handled separately
  .map(([add, del, file]) => ({ file, add, del }));

const binaryChanged = numstat.filter(([add]) => add === "-").map((r) => r[2]);

console.log(`  checked              ${numstat.length} (all, not sampled)`);
console.log(`  with real changes    ${contentChanged.length}`);
if (binaryChanged.length) console.log(`  binary changed       ${binaryChanged.join(", ")}`);

if (contentChanged.length) {
  console.log(`\n  These have genuine content changes, not just line endings:\n`);
  for (const c of contentChanged) console.log(`    +${c.add.padStart(4)} -${c.del.padStart(4)}  ${c.file}`);
  console.log(
    `\n  Deletions with +0 are usually intentional file moves.\n` +
    `  Anything with a non-zero add count is uncommitted work.\n\n` +
    `  Commit or stash it first — this script must not bury it.\n`
  );
  process.exit(1);
}

if (!APPLY) {
  console.log(`\n  Dry run. Nothing changed.`);
  console.log(`  The sample is pure line-ending churn, so normalising is safe.`);
  console.log(`\n  To apply:  node engine/normalise-line-endings.mjs --apply\n`);
  process.exit(0);
}

console.log(`\n  Applying...\n`);

// Order matters. `git checkout -- .` re-materialises the tree from the index,
// which would revert a .gitattributes written before it — the renormalise would
// then run under the OLD rules and silently do nothing. Discard first, write
// the rule second.
execSync("git checkout -- .", { stdio: "inherit" });

writeFileSync(".gitattributes", RULE);
console.log("  wrote .gitattributes");

execSync("git add --renormalize .", { stdio: "inherit" });

// `binary` stops git CONVERTING a file; it does not stop --renormalize staging
// one that is already CRLF-smudged in the working tree. test_eval.pdf was
// smudged by a checkout predating the *.pdf rule, and `git checkout -- .` skips
// it because the stat cache reports it clean — so --renormalize force-read the
// corrupt bytes and staged a 329 -> 350 byte PDF. Never let that reach a commit.
const stagedBinary = sh("git diff --cached --numstat")
  .split("\n")
  .filter(Boolean)
  .filter((l) => l.startsWith("-\t-\t"))
  .map((l) => l.split("\t")[2]);

if (stagedBinary.length) {
  console.error(`\n  Refusing to continue — renormalise staged binary file(s):\n`);
  for (const f of stagedBinary) console.error(`    ${f}`);
  console.error(
    `\n  These are corrupt in the working tree, not in the blob. Restore each:\n` +
    `    git restore --staged <file> && rm <file> && git checkout -- <file>\n\n` +
    `  Then re-run.\n`
  );
  process.exit(1);
}

const staged = sh("git diff --cached --name-only").split("\n").filter(Boolean);
console.log(`\n  renormalised         ${staged.length} file(s)`);
console.log(`\n  Review, then commit:`);
console.log(`    git commit -m "chore: normalise line endings (.gitattributes)"`);
console.log(`    git push origin master\n`);
