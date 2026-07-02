<!-- v1 -->

# Entity Extraction / Disambiguation Prompt

Disambiguate the user's intent when the initial classification is low-confidence.

## Guidance

- Prefer the most likely intent given the conversation context and recent messages.
- Extract structured entities when the user references plan names, retailer names, dates, or amounts.
- If the intent remains genuinely unclear, include a `"clarification"` field with a short, casual follow-up question (NZ English).

## Output

Respond with a JSON object:

```json
{
  "intent": "<intent>",
  "confidence": <0.0-1.0>,
  "entities": {},
  "clarification": "<optional follow-up question>"
}
```
