# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Ruflo MCP tools provide the operational substrate — invoked automatically at each phase, proportional to task complexity. Bias toward caution over speed; for trivial tasks use judgment.

---

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly. When uncertain, ask rather than guess.
- Present multiple interpretations; never silently choose one.
- Flag simpler alternatives. Push back when a request contains security flaws, logical fallacies, or unscalable processes.
- Stop when something is unclear. Name the confusion and ask.

**Ruflo enforcement — execute before any non-trivial edit:**
- `mcp__claude-flow__hooks_route` with the task description → obey the model/agent recommendation. If it routes Tier 1 (Agent Booster), apply the WASM transform directly. If Tier 2 (Haiku), proceed lean. If Tier 3 (Sonnet/Opus), invest full reasoning.
- `mcp__claude-flow__memory_search` with query=`"<task description>"`, smart=true → apply any recalled patterns before writing code.
- `mcp__claude-flow__hooks_pre-task` with taskId and description → records start for learning, returns agent suggestions.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No unrequested features, no abstractions for single-use code, no unasked-for flexibility or configurability.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite.
- **Self-check:** Would a senior engineer say this is overcomplicated?

**Ruflo enforcement:**
- Before writing any abstraction or new module, check `mcp__claude-flow__memory_search` for existing patterns that already solve this — reuse over rewrite.
- After completing a refactor or simplification, call `mcp__claude-flow__memory_store` with key=`"pattern:<descriptive-slug>"`, value=`"<what was simplified and why>"`, namespace=`"patterns"` so future tasks find it.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

- Don't improve adjacent code, comments, or formatting.
- Don't refactor unbroken things.
- Match existing style — inconsistent conventions are worse than suboptimal ones.
- Mention unrelated dead code but do not delete it.
- Remove only imports/variables/functions your changes made unused.
- **Litmus test:** Every changed line must trace directly to the user's request.

**Ruflo enforcement:**
- Before committing or declaring done, run `mcp__claude-flow__analyze_diff` on the working tree → review risk classification and reviewer suggestions. If risk is HIGH, adversarially verify the change.
- Run `mcp__claude-flow__analyze_diff-stats` for a quick change summary — flag any file modified that wasn't part of the task.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

- Transform tasks into verifiable goals with before/after patterns. "Fix the bug" → write a reproducing test first, then make it pass.
- Numbered plan with `→ verify:` checks per step. Strong success criteria enable independent looping; weak criteria require constant clarification.

**Ruflo enforcement:**
- For any multi-step plan, call `mcp__claude-flow__task_create` with type, description, and priority → use the returned taskId to track progress via `mcp__claude-flow__task_update`.
- On completion, call `mcp__claude-flow__task_complete` with the result.
- If a step fails twice, call `mcp__claude-flow__agentdb_feedback` with success=false, quality=score → feeds the learning loop so future routing avoids the same failure mode.

---

## 5. Ruflo Operational Substrate (automatic, every task)

This section defines the mandatory integration points. These happen automatically — do not wait to be asked.

### 5.1 Complexity Escalation Ladder

Assess every task against this ladder and escalate to the appropriate tier:

| Tier | Trigger | Action |
|------|---------|--------|
| **0 — Skip** | Conversation-only, no code touched, factual lookup | No Ruflo overhead. Answer directly. |
| **1 — Agent Booster** | Single-file, mechanical transform (var→const, add types, remove console.log, add error handling, .then()→await) | `hooks_route` will return `[AGENT_BOOSTER_AVAILABLE]`. Apply WASM transform directly. No LLM tokens spent. |
| **2 — Simple** | Single-file bugfix, small feature, test addition | `hooks_route` + `memory_search` for patterns. Use Haiku model. Single-agent execution. |
| **3 — Moderate** | 2-5 files, cross-module change, refactor | Full pre-task ritual. `hooks_route` + `memory_search` + `hooks_pre-task`. Sonnet model. Consider `analyze_diff` before committing. |
| **4 — Complex** | 5+ files, architectural change, new subsystem, security-sensitive | Full pre-task ritual + swarm. `swarm_init` with hierarchical topology, spawn specialized agents via `agent_spawn`, coordinate via `hive-mind`. Post-task: `agentdb_consolidate` + pattern store. |
| **5 — Critical** | Auth, encryption, payments, PII, federation, deployment | Tier 4 ritual + `aidefence_scan` on all inputs + `security-audit` skill + `agentdb_causal-edge` recording for audit trail. Require adversarial verification before committing. |

### 5.2 Pre-Task Ritual (Tiers 2-5)

Executed before any code edit. Proportional to tier:

```
1. hooks_route         → model/agent recommendation (all tiers)
2. memory_search       → recall prior patterns, gotchas, decisions (tiers 2-5)
3. hooks_pre-task      → record task start, get agent suggestions (tiers 3-5)
4. swarm_init          → orchestrate multi-agent work (tiers 4-5 only)
```

### 5.3 Post-Task Ritual (Tiers 2-5)

Executed after task completion, before declaring done:

```
1. analyze_diff        → change risk assessment (tiers 3-5)
2. hooks_post-task     → record outcome for learning (tiers 2-5)
3. memory_store        → persist key lesson/pattern (tiers 2-5)
4. agentdb_feedback    → quality signal for routing improvement (tiers 3-5)
5. agentdb_consolidate → promote working→episodic→semantic memory (tiers 4-5 only, or every 5th task)
```

### 5.4 Session Lifecycle

**Session start** (first task of a new conversation):
- `mcp__claude-flow__hooks_session-start` with restoreLatest=true → recovers prior swarm state, task list, and memory context.
- `mcp__claude-flow__memory_search` with query="session context open tasks patterns" → surfaces what was in flight.

**Session end** (user indicates done, or long idle period):
- `mcp__claude-flow__hooks_session-end` with saveState=true, exportMetrics=true → persists state for next session.

### 5.5 Memory Loop (continuous)

Every code change feeds the learning loop:

```
Code change → hooks_post-task (outcome) → agentdb_feedback (quality)
                                           ↓
                              RETRIEVE → JUDGE → DISTILL → CONSOLIDATE
                                           ↓
                              Next hooks_route benefits from improved routing
```

- Store patterns: `mcp__claude-flow__agentdb_pattern-store` for reusable solutions.
- Store decisions: `mcp__claude-flow__agentdb_hierarchical-store` with tier="semantic" for architectural choices.
- Link causal relationships: `mcp__claude-flow__agentdb_causal-edge` between related decisions.

---

## 6. Tool Selection Rules

### Security
- Untrusted input → `mcp__claude-flow__aidefence_scan` before processing.
- Security-sensitive changes → `mcp__claude-flow__security-audit` skill.
- PII detection → `mcp__claude-flow__aidefence_has_pii` on any data that might contain credentials or personal data.

### Diff & Git
- Before any commit → `mcp__claude-flow__analyze_diff` for risk classification.
- Multi-commit work → `mcp__claude-flow__analyze_diff-stats` between commits for quick overview.
- PR creation → `mcp__claude-flow__analyze_diff-reviewers` for reviewer recommendations.

---

## 7. Integration Checklist (self-verification)

Before declaring any non-trivial task complete, verify:

- [ ] `hooks_route` was called and its recommendation was followed
- [ ] `memory_search` returned relevant patterns (or confirmed none exist)
- [ ] `analyze_diff` shows risk level is acceptable
- [ ] Key insight or pattern was stored via `memory_store` or `agentdb_pattern-store`
- [ ] Task outcome recorded via `hooks_post-task`
- [ ] If task touched 5+ files, swarm coordination was used
- [ ] If task involved security/auth/PII, `aidefence_scan` was run
- [ ] No speculative code or unrequested features were added
- [ ] Every changed line traces to the user's request

---

## 8. Anti-Patterns

- **Do NOT** call every Ruflo tool on every keystroke. Use the complexity ladder — Tier 0 tasks need zero overhead.
- **Do NOT** spawn a swarm for a single-file fix. The escalation ladder exists to prevent over-engineering the process.
- **Do NOT** skip `memory_search` because "this looks simple." Many bugs repeat; the pattern store catches them.
- **Do NOT** store noise in memory. Only persist patterns that are genuinely reusable, decisions with trade-off rationale, or errors with root causes.
- **Do NOT** invoke Ruflo tools silently without acting on the result. If `hooks_route` says Tier 1 (Agent Booster), use it. If it recommends a reviewer agent, spawn it.

---

*These guidelines are working when: diffs contain fewer unnecessary changes, fewer rewrites due to overcomplication, clarifying questions precede implementation rather than following mistakes, and Ruflo's pattern recall surfaces relevant prior art before coding begins.*

---

## Project Context

**Flip — Interfaceless B2C SaaS for NZ Power Bill Monitoring.** Monitors residential power bills and notifies users via WhatsApp/SMS when switching plans saves money. "Stay where you are" is a first-class recommendation. Stack: Cloudflare Workers (TypeScript strict, Hono), D1 (SQLite), Queues, KV, R2, Sent messaging, DeepSeek NLU, deterministic Python bill parsing. Currently Phase 1 (core infrastructure). See `docs/PLAN.md` and `docs/ARCHITECTURE.md` for full 7-phase plan.

**Full requirements:** [REQUIREMENTS.md](REQUIREMENTS.md)
