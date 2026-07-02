# Prompt Changelog

All notable changes to Flip's prompt templates are documented here.

Each prompt file carries a `<!-- vN -->` header. Bump the version and add an
entry below whenever prompt wording changes.

## [1.1.0] — 2026-07-02

Initial split of the monolithic `SYSTEM_PROMPT` into versioned, single-purpose
templates under `services/prompts/`. The `PROMPT_VERSION` constant in
`prompts.ts` moved from `1.0.0` to `1.1.0` to reflect the new structure.

- **system.md** (v1): Shared persona and NZ English tone rules, extracted from
  the original `SYSTEM_PROMPT`.
- **intent-classification.md** (v1): The 10-intent taxonomy and output JSON
  schema instructions, extracted from the original `SYSTEM_PROMPT`.
- **entity-extraction.md** (v1): Disambiguation guidance for the Pro model,
  derived from the `disambiguate` call's instructions.
- **notification-content.md** (v1): Placeholder phrasing guidance for outbound
  notifications; full copy lands in a later phase.

## [1.0.0]

Monolithic inline `SYSTEM_PROMPT` string in `deepseek.ts`, shared verbatim by
`classifyIntent` and `disambiguate`.
