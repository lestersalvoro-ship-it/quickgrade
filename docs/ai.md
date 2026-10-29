# AI features

AI is optional. Scanning, grading, analytics and exports never call an AI service, and AI never sets or changes a score.

## Enabling

1. Create an API key in the Anthropic Console.
2. On the **server**, set it in `.env` or your platform's secret manager (never in frontend code or version control):
   ```
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...
   AI_MODEL=claude-opus-5-5
   ```
3. Restart. `GET /api/health` and **AI Assistant → Usage** should show `enabled: true`.

Without a key every AI screen shows **"AI is pending configuration"**, and the API returns `503 AI_UNAVAILABLE`.

## Features

| Feature | Where | Data sent |
|---|---|---|
| Question generator | AI Assistant → Question generator | Subject, topic, grade level, difficulty, objectives you type |
| Quiz from material | AI Assistant → Quiz from material | The above plus pasted text or a .txt/.md file (≤ 30,000 characters). Emails and long digit strings are removed first |
| Performance insights | Results → session → AI insights | **Aggregates only**: number graded, score statistics, distribution, per-question % correct and answer distribution, discrimination, the topics you tagged, and the question text you entered. No names, student numbers or individual responses |
| Practice recommendations | same tab | Same aggregates. Generates practice questions only when question text or topics exist |
| Question explanation | Quiz editor → expand a question → Explain with AI | The question text, choices and keyed answer |

All generated content lands in an **editable review screen**. Questions only become part of a quiz after you open them in the quiz editor and save, which goes through the same validation as manual quizzes (choice count, valid key, lengths). Insights are shown as hypotheses with caveats. Topics the AI mentions that you did not tag are discarded.

## Safeguards and costs

- **Server-side only:** requests use the official `@anthropic-ai/sdk` with structured JSON outputs, a timeout (`AI_TIMEOUT_MS`), automatic retries for transient errors, and `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). If a safety classifier declines, the API can retry on its recommended fallback model.
- **Validation:** every response is re-validated by the server (`server/src/ai/schemas.ts`). Malformed items are dropped and counted.
- **Limits:** `AI_DAILY_REQUESTS_PER_TEACHER` (default 40) and `AI_MONTHLY_BUDGET_USD` (server-wide estimated spend, default $20; 0 = no cap), plus a per-IP rate limit of 10 AI requests per minute.
- **Usage tracking:** every call is recorded in `ai_requests` with tokens and estimated cost (from `AI_INPUT_USD_PER_MTOK` / `AI_OUTPUT_USD_PER_MTOK`). Teachers can see their usage on the Usage tab.
- **Errors:** rate limits, timeouts, outages, refusals and invalid outputs each produce a clear message. Nothing else in the app is affected.

## Changing provider

Implement `AiProvider` (`server/src/ai/provider.ts`): one `generate({ system, prompt, schema, maxTokens })` method returning parsed data and token counts. Then construct it in `createAiService`. Feature prompts, validation, limits and storage are provider-independent.

## Status

The integration is implemented and tested with a fake provider (validation, anonymisation, limits, error mapping). **Live calls against the Anthropic API were not exercised in the development environment because no API key was available.**
