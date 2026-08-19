# Flip — GA launch checklist

**Version 1.0 · 2026-08-20** · The working paper for the general-availability go/no-go review (issue #106). `docs/OPERATIONS.md` §11 remains the canonical gate; this file adds what that list lacks — per-item status, owners, evidence, and a record of the decision.

## What this document is

The gate is the seven-item numbered list in `docs/OPERATIONS.md` §11, plus two further launch-blocking requirements stated in `docs/PRD.md` (§10.4 and §11a). All nine are reproduced in the table below, the seven in the operations document's own order and wording.

The rule is plain: **GA does not proceed while any item is RED.** An UNKNOWN item is not a pass — it is an unanswered question, and the review must resolve it to GREEN or RED on evidence before a decision is recorded.

The status column was derived from the repository on 2026-08-20. It is a snapshot, not a fact about the world: anything that turns on an external party, a production system, or a commercial or legal fact is UNKNOWN precisely because the repository cannot answer it. Every row must be re-verified at the meeting against the live repository and the live systems — do not trust this file's age. The review is signed off in the block at the end by the product owner (Sam) and the engineer presenting the evidence; neither name is filled in until the meeting happens.

### Status and owner conventions

| Status | Means |
|---|---|
| GREEN | Verified, with evidence, in the repository |
| AMBER | Met today, but an open issue could regress it before GA |
| RED | The repository shows the gate is not met |
| UNKNOWN | The repository cannot answer; verification sits outside it |

Owners follow one rule: **Sam** owns anything requiring a human decision, a credential, a payment or an external party; everything else is **unassigned** repo work. No row currently holds GREEN or AMBER — nothing about this launch has been verified yet.

## The gate table

| # | Gate | Status | Owner | Evidence / blocking issue | Verified on |
|---|---|---|---|---|---|
| 1 | Legal entity formed; privacy policy and terms live | UNKNOWN | Sam | `docs/PRD.md:174` — both are hard blockers, "no external user before both are live". Also #102: the retention windows the policy must state (PRD §10.3) are not yet enforced — `docs/OPERATIONS.md:164` | — |
| 2 | Stripe live | RED | Sam | `workers/src/index.ts:147` registers `POST /webhook/stripe` as `notImplemented`, and no checkout code exists in the Worker; `docs/OPERATIONS.md:40` still defers the Stripe secrets to "when Stripe lands" | — |
| 3 | Parser accuracy met on real bills — >90% top five, >80% elsewhere | RED | Sam | `docs/PRD.md:237` — the bar is measured against a corpus of real bills, and sourcing ~20 per major retailer is an open task; with no corpus the bar cannot have been met | — |
| 4 | **sent.dm sends confirmed working** (pending approval on their side) | UNKNOWN | Sam | `docs/PRD.md:243` — approval pending on sent.dm's side; the repository cannot see their process | — |
| 5 | **D1 migration ledger rebuilt and verified** | RED | Sam | #290; `docs/OPERATIONS.md:75` — the remote D1 has no `d1_migrations` ledger, and the rebuild is human-gated, single attempt (verification item V-1) | — |
| 6 | Data deletion verified across D1, R2 and OAuth revocation | RED | unassigned | #116 — `revokeAccess` (`workers/src/services/gmailAuth.ts:133`) has no non-test callers, so the OAuth leg cannot pass | — |
| 7 | Seven consecutive green end-to-end trace runs | RED | Sam | #105; `docs/OPERATIONS.md:14` — staging is to build, and runbook §6.1 (`docs/OPERATIONS.md:112`) requires staging with `FLOW_TEST_MODE=true`. Independently, the flow's ingest and notify legs traverse DeepSeek model identifiers retired on 2026-07-24 — #283, `workers/src/services/deepseek.ts:11` | — |
| 8 | Deletion and OAuth revocation verified end to end before launch — "the revocation step in particular" (PRD §10.4) | RED | unassigned | `docs/PRD.md:205`; same blocker as row 6 (#116). `docs/OPERATIONS.md:138` (runbook §6.5, verification item V-4) names the revocation step as the one most likely to be missed | — |
| 9 | The messaging leg — alert delivery verified end to end in the acceptance path (PRD §11a) | UNKNOWN | Sam | `docs/PRD.md:243` — it remains a launch gate while sent.dm approval is pending. #297 — the acceptance runner fails the engine gate the first time a probe passes, so the path cannot be evidenced even once approval lands | — |

Rows 1–7 are the canonical list from `docs/OPERATIONS.md` §11. Rows 8–9 are further launch-blocking gates stated in the PRD.

The same seven items also appear as `docs/PRD.md` §12, worded slightly differently. Two copies of one gate is drift waiting to happen: if an item changes, change both, and prefer citing §11 here.

## What would have to happen

The concrete next action for each RED or UNKNOWN row, and who must take it.

1. **Legal entity, policy and terms (row 1, UNKNOWN).** Sam forms the entity and publishes the privacy policy and terms. Before the policy states the PRD §10.3 retention windows, the purge behind #102 must actually run — `docs/OPERATIONS.md:164` records those windows as not yet implemented, and a policy that states windows the system does not enforce would misstate practice.
2. **Stripe live (row 2, RED).** The Stripe surface must first be built: checkout and a real webhook handler, where `/webhook/stripe` is a stub (`workers/src/index.ts:147`). That is unassigned repo work; taking the account live — keys, live mode, a real charge — is Sam's.
3. **Parser accuracy (row 3, RED).** Sam sources the corpus of real anonymised bills, roughly 20 per major retailer (PRD §15, open decision 3). Accuracy is then measured against that corpus; until it exists the bar can be neither evaluated nor met.
4. **sent.dm sends (row 4, UNKNOWN).** Sam confirms sent.dm's approval status and, once granted, a real send is verified end to end. If sends are dead at that point, runbook §6.2 (`docs/OPERATIONS.md:122`) is the diagnostic order.
5. **D1 migration ledger (row 5, RED).** Sam runs the human-gated rebuild procedure in `docs/OPERATIONS.md` §4.1 (#290) — back up first, single attempt. Everything schema-carrying queues behind it, including #289's notification-type migration.
6. **Data deletion (row 6, RED).** `revokeAccess` is wired into the deletion path and given a non-test caller (#116) — unassigned repo work. The end-to-end verification, one real deletion request with all three stores checked, then needs Sam against production.
7. **Seven green traces (row 7, RED).** Sam provisions staging (#105 — it costs money and needs account access). Even then the traces traverse DeepSeek calls whose identifiers were retired on 2026-07-24 (#283), so the move to `deepseek-v4-pro` with a verified round-trip on each call path must land first.
8. **Deletion end to end, revocation in particular (row 8, RED).** Shares row 6's blocker, #116; runbook §6.5 then verifies all three stores against a real request. This is verification item V-4 in the decisions log.
9. **The messaging leg (row 9, UNKNOWN).** sent.dm approval lands (Sam) and the leg is added to the acceptance path per PRD §11a. Separately, #297 must be decided — as it stands, the first passing probe dirties the tree and fails the engine gate, so no green acceptance run can be recorded.

## Sign-off

Recorded at the review, not before. The decision is one of Go, No-go, or Conditional go; a Conditional go must list its conditions beneath the table.

| Role | Name | Date | Decision (Go / No-go / Conditional go) |
|---|---|---|---|
| Product decision | Sam | — | not yet recorded |
| Engineering decision | not yet named | — | not yet recorded |

Conditions of a Conditional go: none recorded.
