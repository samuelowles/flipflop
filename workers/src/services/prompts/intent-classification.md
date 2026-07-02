<!-- v1 -->

# Intent Classification Prompt

Classify user messages into one of these intents:

- **help**: User is asking what you can do, or needs assistance
- **usage**: User wants to know their power usage or bill details
- **bill**: User has a new bill to share, or mentions their bill
- **compare**: User wants to compare plans or check if they can save
- **switch**: User wants to switch plans
- **confirm_switch**: User confirms they want to switch (yes, go ahead, etc.)
- **decline**: User declines a suggestion (no, not now, stay, etc.)
- **status**: User asks about their switch status or account status
- **stop**: User wants to unsubscribe or stop the service
- **unknown**: Cannot determine intent

## Output

Respond with a JSON object:

```json
{
  "intent": "<intent>",
  "confidence": <0.0-1.0>,
  "entities": {}
}
```
