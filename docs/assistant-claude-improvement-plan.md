# Plan: closing the gaps in Media Assistant on Claude

Findings come from a live capability run of `anthropic/claude-sonnet-5-5` through Merge Gateway (see `docs/assistant-runtime-contract.md`). Model quality was not the problem; the gaps are in cost, latency, resilience and untested areas.

## Done

| Gap | Change |
|---|---|
| Instructions billed in full on every call (~39k tokens, 7.8¢) | The system prompt is sent with `cache_control`, so new sessions read it from cache (measured 0.4¢). Enabled for `merge_gateway` via `PROMPT_CACHE_KINDS`. |
| No retry on gateway errors | `assistant_runtime/resilience.py` retries 408/409/425/429/5xx and connection errors up to 3 attempts (1 s, 3 s backoff), stops on Stop, never retries 4xx. |
| Compaction broke the cache and cut mid-turn | Compaction drops whole turns, always starts on a user message, and trims to 60% of the budget, so it happens once every several turns instead of every turn. |
| Misleading "passed preflight" wording | A graph with no generation nodes now says no inputs were checked (`generation_readiness.status` is `empty`). It is not blocked, because other node types may still be runnable. |
| Streaming support | `assistant_runtime/streaming.py` reads the SSE stream, honours Stop by closing the connection, and treats cut-off streams as retryable. It is opt-in with `MEDIA_ASSISTANT_STREAM=1`. See the finding below. |

These are covered by unit tests. The cache saving was confirmed live through the runtime with two calls in separate new sessions: the second read all 20,308 prompt tokens from cache and cost 0.2¢ instead of 5.1¢. Retries and compaction have not been exercised against the live gateway.

## Remaining gaps

Ordered by value for effort.

### 1. Latency (median 12.7 s per turn; 30-38 s for stories and large graphs)
- **Cause:** 2-5 sequential provider calls per turn, plus long single outputs.
- **Streaming does not help here.** I measured Merge Gateway: on `/v1/openai/chat/completions` and on `/v1/anthropic/v1/messages`, every event arrives at once after the full response (5.2 s and 5.7 s for a 400-token answer). The kernel also needs the whole JSON step before it can act. So streaming saves no time with Merge.
- **Options still open:**
  1. Let the model request several independent read tools in one step (for example `list_graph_node_types`, called 4 times in one turn). This needs a kernel schema change and is the largest item.
  2. Route cheap steps (lookups, replies) to a smaller model (`MERGE_FAST_MODEL`) and keep Sonnet for plan and draft steps.
  3. Trim the ~39k-token instruction bundle per capability. Caching already cuts its cost; trimming also cuts time to first token.
- **Verify:** mocked step-count tests; compare p50 turn time on a fixed 6-prompt script.

### 2. Stop keeps billing
- **Cause:** a chat completion cannot be aborted. Stop discards the result, but the provider keeps generating.
- **Streaming is in place but cannot fix this on Merge.** Because Merge buffers the stream, closing our side probably does not reach Anthropic. In a live test, cancelling 2 s into a long answer only took effect after 11 s, when the buffered events arrived. Whether the gateway cancels upstream is not observable from our side.
- **Next step:** ask Merge whether a client disconnect cancels the upstream request, and check the dashboard cost of a cancelled call. Streaming remains useful for providers that stream properly (OpenRouter, local servers); try it with `MEDIA_ASSISTANT_STREAM=1`.
- **Fallback:** a lower `max_tokens` for chat-only steps limits the cost of an abandoned call.

### 3. Cost visibility and limits
- Per-turn `cost` is already in `usage`. Add a per-session spend total in the turn trace and a soft cap (`MEDIA_ASSISTANT_MAX_SESSION_COST`) that refuses new turns with a clear message.
- Add a second `cache_control` marker at the end of replayed history, so long conversations also cache their transcript.

### 4. Setup and UI
- Merge can only be selected with `MEDIA_ASSISTANT_PROVIDER`; add it to the Settings provider list, with the model chosen there.
- `resolve_assistant_provider_runtime` still requires an API key for every non-Codex provider, which blocks keyless local servers.

### 5. Not yet tested
Multiple images, video references, plans and drafts with many tool calls, conversations that reach the real 240,000-character compaction budget, and Haiku vs Sonnet quality per capability.

## Testing without a large bill
- Prefer mocked provider tests. They cover retries, compaction, cache markers and schemas for free.
- For live checks use one smoke script of at most 3 calls with `max_tokens` capped. Check `usage.prompt_tokens_details.cached_tokens` on the second call of a new session.
- Run the full capability battery only on request. The last run cost about 1.2 USD.
