# Media Assistant runtime contract

The Media Assistant kernel is provider-neutral. It talks to its model through a small seam, `AssistantRuntime`, in `apps/api/app/assistant_runtime/`. Codex Local is the supported implementation. A second, experimental implementation for OpenAI-compatible endpoints exists behind a flag. This document describes the contract, the two implementations, and how to add another runtime.

For user-facing requirements see [Media Assistant setup](media-assistant-setup.md). For the product-level architecture see [project-architecture-overview.md](project-architecture-overview.md).

## Why the seam exists

The kernel (`apps/api/app/assistant/kernel.py`) runs its **own** tool loop. On each iteration it asks a runtime for one JSON "step" that matches `AssistantKernelProviderStep`. It executes the requested tool in-process and sends the tool result back. The runtime never executes Media Studio tools.

Approvals are also Media Studio's own: the propose, review, apply and run-confirmation flow lives in `assistant/` routes and plans. Codex App Server is started with `approvalPolicy: "never"` and a read-only sandbox, so none of its approval or tool features are used.

So the runtime only has to provide what a model endpoint provides:

| Need | Meaning |
| --- | --- |
| Structured output | One JSON step per call that matches a strict schema |
| Conversation memory | The kernel sends only new messages after the first call of a turn |
| Compaction | Optionally shrink context when asked (`compact_before_turn`) |
| Cancellation | Stop must end an in-flight call |
| Vision | Image input, used only by reference and output analysis |
| Usage and trace data | Tokens, latency and lifecycle for turn traces |

## The interface

Defined in `apps/api/app/assistant_runtime/__init__.py`.

```python
class AssistantRuntime(Protocol):
    kind: str                          # provider_kind, e.g. "codex_local"
    capabilities: RuntimeCapabilities  # structured_output, vision, provider_managed_state, compaction

    def run_step(self, request: StepRequest) -> StepResult: ...
    def was_interrupted(self, error: BaseException) -> bool: ...
    def close_session(self, session_key: str) -> None: ...
    def archive_session(self, session_key: str, provider_state: str) -> bool: ...
```

- **`StepRequest`** holds the model id, the message delta, the response schema, instructions, cancel event, timeout, and an optional `RuntimeConnection` (base URL, key, temperature, max tokens) for remote runtimes. A request with `session_key=None` is a **stateless** one-shot call, used by visual analysis. Otherwise `provider_state` is the opaque continuity handle returned by the previous step.
- **`StepResult`** returns the text (JSON when a schema was given), the new `provider_state`, usage, timing, compaction info and lifecycle strings. `trace_fields()` maps it onto `AssistantKernelProviderTrace`.
- **`provider_state`** is persisted as `assistant_sessions.provider_thread_id`. The kernel never interprets it.

### Error contract

- Any provider failure, including a Stop, raises `RuntimeStepError`. This is an alias of `enhancement_provider.EnhancementProviderError`. Do not leak other exception types.
- `was_interrupted(error)` is true only when the failure came from a provider-side interrupt. The kernel uses it to choose the cancellation outcome (`interrupted` or `process_reset`).
- A stale or unknown `provider_state` must not be fatal. Start a replacement conversation and report it in `lifecycle`, for example `thread_resume_failed` then `thread_replaced`.
- A failed step must not advance conversation state.

### Registry and gating

`get_assistant_runtime(kind)` returns the registered runtime or `None`. The kernel and the analysis tools gate on capabilities, not on provider names:

- `runtime_supports_kernel(kind)` means the tool-capable kernel runs. Otherwise the Assistant falls back to read-only chat.
- `runtime_supports_vision(kind)` means reference and output analysis are allowed.

## Implementations

### Codex Local (`assistant_runtime/codex.py`, supported)

A thin adapter over `enhancement_provider.run_codex_local_chat` and the Codex App Server helpers. Codex keeps the conversation in a durable thread (`provider_managed_state=True`), supports compaction and vision, and reports process-reuse details. All Codex-specific behavior stays in `codex_local_provider.py`.

### OpenAI-compatible (`assistant_runtime/openai_compatible.py`, experimental)

For `local_openai` and `openrouter`. These endpoints are stateless, so the adapter owns the conversation (`provider_managed_state=False`):

- It persists a transcript per session under `data/runtime/assistant-transcripts/<id>.json`. `provider_state` is the transcript id. The `/media/files` endpoint refuses this directory.
- It replays the transcript on each step. A new transcript starts when instructions or the session key change.
- Compaction **drops the oldest messages** once a character budget is exceeded. It does not summarize.
- It normalizes the step schema for strict structured output, and accepts JSON wrapped in a code fence. Anything else is reported as a step error and is not stored.
- Kernel steps use at least 4,000 completion tokens, because the 900-token chat default truncates plans and drafts.
- Stop abandons the in-flight HTTP request. The request cannot be aborted, but its result is discarded.
- Vision is off by default, so reference and output analysis are unavailable.

It is **disabled by default**. Enable it by listing provider kinds in `.env`, then restart the API:

```env
MEDIA_ASSISTANT_EXPERIMENTAL_RUNTIMES=local_openai
```

Then choose that provider in **Settings → AI → Media Assistant**.

#### Known gaps

- The Graph Studio setup panel still checks `codex_local_ready` from `/health`, so the web UI will show the Codex setup message even when an experimental runtime would work. This needs a runtime-aware readiness field.
- `resolve_assistant_provider_runtime` requires an API key for every non-Codex provider, which blocks local servers that need no key.
- Summarizing compaction and a vision-capable configuration are not implemented.
- The prototype has not been run against a live model. Strict JSON-schema reliability varies by endpoint and model.
- A Claude-based runtime has not been built. See "Adding a runtime".

## Adding a runtime

1. Implement the `AssistantRuntime` protocol in `apps/api/app/assistant_runtime/<name>.py`. Decide `provider_managed_state`. If it is false, own the transcript and compaction as the OpenAI-compatible runtime does.
2. Register it with `register_runtime(...)`. Gate it behind `MEDIA_ASSISTANT_EXPERIMENTAL_RUNTIMES` until it is proven, and add the kind to `PROMPT_RECIPE_DRAFTING_PROVIDERS` so it can be selected.
3. Add a harness to `apps/api/tests/test_assistant_runtime_contract.py`. A harness fakes only the backend, such as the HTTP call or the process wrapper. Add it to `HARNESSES`. It must pass every contract test unchanged.
4. Add runtime-specific tests, like the OpenAI-compatible ones in `test_assistant_runtime_seam.py`.
5. Run the Assistant CI gate: `npm run quality:assistant-ci`.

### Notes for a Claude-based runtime

The kernel needs a model that emits one schema-valid step with memory between calls, not a coding agent. Two realistic options:

- **Anthropic API directly**, with adapter-managed state like the OpenAI-compatible runtime. Simplest, but you own replay and compaction.
- **Claude Code or the Agent SDK** in a locked-down headless mode, with its built-in tools disabled and a resumable session as `provider_state`. It would behave like Codex but needs its own cancellation, usage and credential handling.

Verify the current Claude Code and SDK capabilities (structured output, session resume, interruption) before choosing. Either route plugs into this seam without kernel changes.

## Contract tests

`test_assistant_runtime_contract.py` runs the same tests against every harness. They cover:

- registration and declared capabilities;
- schema-valid JSON results and a normalized `StepResult`;
- resuming a conversation and keeping earlier context;
- a stale `provider_state` being replaced, not fatal;
- stateless calls leaving no state behind;
- provider failures raising `RuntimeStepError`;
- Stop interrupting a hung call and `was_interrupted` telling it apart from other errors;
- failed steps not advancing state;
- compaction reporting an honest outcome;
- tolerance of missing optional provider fields;
- archive and close semantics.

`test_assistant_runtime_seam.py` proves the kernel itself is runtime-agnostic. A fake non-Codex runtime drives a full kernel turn, cancellation outcomes, session close and archive, and capability gating. It also covers the OpenAI-compatible specifics, the feature flag, and the transcript file-serving restriction.
