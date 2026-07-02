## Summary

<!-- Brief description of the change -->

## Checklist

- [ ] Tests added/updated
- [ ] `npm run typecheck && npm run lint && npm test` passes locally from `workers/`
- [ ] No secrets, credentials, or PII committed
- [ ] No user bill data, ICP, address, or PII added to any prompt template

## Prompt changes

<!-- Complete this section if this PR edits anything under workers/src/services/prompts/ or the prompt constants in workers/src/services/prompts.ts. Delete otherwise. -->

- [ ] The `<!-- vN -->` version header in each changed `.md` file has been bumped
- [ ] An entry has been added to `workers/src/services/prompts/CHANGELOG.md`
- [ ] `PROMPT_VERSION` in `workers/src/services/prompts.ts` matches the new CHANGELOG version
- [ ] The TS prompt constants and canonical `.md` files are in sync (`// ponytail:` note in `prompts.ts`)
- [ ] Reviewer has explicitly checked the prompt wording diff for tone, leakage, and intent coverage
