"""Kernel-level and OpenAI-compatible runtime tests for the runtime seam."""

from __future__ import annotations

import importlib
import json
import threading
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest


class ScriptedRuntime:
    """Minimal fake runtime proving the kernel does not depend on Codex."""

    kind = "scripted_test"

    def __init__(self, *, structured: bool = True, vision: bool = False) -> None:
        runtime_module = importlib.import_module("app.assistant_runtime")
        self.capabilities = runtime_module.RuntimeCapabilities(
            structured_output=structured,
            vision=vision,
            provider_managed_state=False,
            compaction=False,
        )
        self.requests: List[Any] = []
        self.closed: List[str] = []
        self.archived: List[tuple] = []
        self.error: Exception | None = None
        self.interrupted = False
        self.text = '{"capability":"general","reply":"scripted"}'

    def run_step(self, request):
        runtime_module = importlib.import_module("app.assistant_runtime")
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return runtime_module.StepResult(
            text=self.text,
            provider_state="scripted-state-1",
            provider_turn_id="turn-9",
            usage={"prompt_tokens": 3},
            latency_ms=4,
            prompt_bytes=99,
            lifecycle=["thread_started"],
            process_lifecycle="no_process",
            reuse_mode="client_replay",
        )

    def was_interrupted(self, error):
        return self.interrupted

    def close_session(self, session_key):
        self.closed.append(session_key)

    def archive_session(self, session_key, provider_state):
        self.archived.append((session_key, provider_state))
        return True


@pytest.fixture()
def scripted(app_modules, monkeypatch):
    runtime_module = importlib.import_module("app.assistant_runtime")
    kernel = importlib.import_module("app.assistant.kernel")
    runtime = ScriptedRuntime()
    runtime_module.register_runtime(runtime)
    session = app_modules["store_assistant"].create_or_update_assistant_session(
        {
            "provider_kind": "scripted_test",
            "provider_model_id": "scripted-model",
            "state_snapshot_json": {"provider_generation": 2},
        }
    )
    monkeypatch.setattr(
        kernel,
        "resolve_assistant_provider_runtime",
        lambda _session: SimpleNamespace(
            provider_kind="scripted_test",
            provider_model_id="scripted-model",
            provider_base_url="http://example.invalid/v1",
            api_key="secret",
            temperature=0.2,
            max_tokens=777,
        ),
    )
    return SimpleNamespace(kernel=kernel, runtime=runtime, session=session, modules=app_modules)


def test_kernel_step_runs_on_a_non_codex_runtime(scripted) -> None:
    lifecycle: List[str] = []
    traces: List[Any] = []

    step = scripted.kernel.run_kernel_provider_step(
        session=scripted.session,
        messages=[{"role": "user", "content": "go"}],
        cancel_event=None,
        timeout_seconds=None,
        provider_lifecycle=lifecycle,
        provider_steps=traces,
        thread_base_instructions="base",
        thread_developer_instructions="dev",
        client_user_message_id="m1",
    )

    assert step == {"capability": "general", "reply": "scripted"}
    request = scripted.runtime.requests[0]
    assert request.session_key == f"{scripted.session['assistant_session_id']}:2"
    assert request.base_instructions == "base"
    assert request.connection.base_url == "http://example.invalid/v1"
    assert request.connection.max_tokens == 777
    assert request.response_schema["json_schema"]["name"] == "media_assistant_kernel_step"
    stored = scripted.modules["store_assistant"].get_assistant_session(scripted.session["assistant_session_id"])
    assert stored["provider_thread_id"] == "scripted-state-1"
    assert lifecycle == ["thread_started"]
    assert traces[0].process_lifecycle == "no_process"
    assert traces[0].reuse_mode == "client_replay"
    assert traces[0].usage == {"prompt_tokens": 3}


def test_kernel_turn_uses_tool_loop_instead_of_read_only_chat(scripted) -> None:
    result = scripted.kernel.run_assistant_kernel_turn(
        session=scripted.session,
        user_text="hello",
        workflow=None,
        canvas_context={},
        assistant_mode=None,
    )

    assert result.reply == "scripted"
    assert result.trace.termination != "read_only_provider"
    assert scripted.runtime.requests, "the scripted runtime must have served the turn"


def test_runtime_without_structured_output_falls_back_to_read_only(scripted, monkeypatch) -> None:
    runtime_module = importlib.import_module("app.assistant_runtime")
    runtime_module.register_runtime(ScriptedRuntime(structured=False))
    called: Dict[str, bool] = {}

    def read_only(**_kwargs):
        called["read_only"] = True
        return "sentinel"

    monkeypatch.setattr(scripted.kernel, "run_read_only_provider_turn", read_only)

    outcome = scripted.kernel.run_assistant_kernel_turn(
        session=scripted.session, user_text="hi", workflow=None, canvas_context={}, assistant_mode=None
    )

    assert outcome == "sentinel" and called == {"read_only": True}


def test_unknown_runtime_is_rejected_for_kernel_steps(scripted, monkeypatch) -> None:
    runtime_module = importlib.import_module("app.assistant_runtime")
    runtime_module.unregister_runtime("scripted_test")

    with pytest.raises(scripted.kernel.AssistantProviderChatError):
        scripted.kernel.run_kernel_provider_step(
            session=scripted.session,
            messages=[{"role": "user", "content": "go"}],
            cancel_event=None,
            timeout_seconds=None,
        )


@pytest.mark.parametrize("interrupted, outcome", [(True, "interrupted"), (False, "process_reset")])
def test_cancelled_step_outcome_comes_from_the_runtime(scripted, interrupted, outcome) -> None:
    enhancement = importlib.import_module("app.enhancement_provider")
    cancel = threading.Event()
    cancel.set()
    scripted.runtime.error = enhancement.EnhancementProviderError("stopped")
    scripted.runtime.interrupted = interrupted
    cancellation = importlib.import_module("app.assistant.cancellation")

    with pytest.raises(cancellation.AssistantRequestCancelled) as caught:
        scripted.kernel.run_kernel_provider_step(
            session=scripted.session,
            messages=[{"role": "user", "content": "go"}],
            cancel_event=cancel,
            timeout_seconds=None,
            provider_steps=[],
        )

    assert caught.value.outcome == outcome


def test_session_provider_switch_closes_through_the_owning_runtime(scripted) -> None:
    provider_support = importlib.import_module("app.assistant.provider_support")
    store_assistant = scripted.modules["store_assistant"]
    session = store_assistant.create_or_update_assistant_session(
        {**scripted.session, "provider_kind": "scripted_test", "provider_thread_id": "old"}
    )

    provider_support.sync_assistant_session_provider(session, force_new_thread=True)

    assert scripted.runtime.closed == [provider_support.assistant_session_key(session)]


def test_archive_session_uses_runtime_archive(scripted) -> None:
    provider_support = importlib.import_module("app.assistant.provider_support")
    store_assistant = scripted.modules["store_assistant"]
    session = store_assistant.create_or_update_assistant_session(
        {**scripted.session, "provider_kind": "scripted_test", "provider_thread_id": "thread-x"}
    )

    archived = provider_support.archive_assistant_session(session)

    assert scripted.runtime.archived == [(provider_support.assistant_session_key(session), "thread-x")]
    assert archived["state_snapshot_json"]["provider_archive_status"] == "archived"


def test_visual_analysis_requires_vision_capability(scripted) -> None:
    analysis = importlib.import_module("app.assistant.reference_analysis")
    enhancement = importlib.import_module("app.enhancement_provider")
    context = SimpleNamespace(cancel_event=threading.Event(), provider_steps=[])

    with pytest.raises(enhancement.EnhancementProviderError):
        analysis._run_visual_analysis(context, runtime_kind="scripted_test", model_id="m", messages=[])

    runtime_module = importlib.import_module("app.assistant_runtime")
    runtime_module.register_runtime(ScriptedRuntime(vision=True))
    result = analysis._run_visual_analysis(context, runtime_kind="scripted_test", model_id="m", messages=[])

    assert result.text
    assert len(context.provider_steps) == 2


# -- OpenAI-compatible prototype -------------------------------------------------


@pytest.fixture()
def openai_runtime(app_modules, monkeypatch):
    del app_modules
    module = importlib.import_module("app.assistant_runtime.openai_compatible")
    runtime_module = importlib.import_module("app.assistant_runtime")
    ep = importlib.import_module("app.enhancement_provider")
    captured: List[Dict[str, Any]] = []
    replies = ['{"reply":"ok"}']

    def fake_chat(**kwargs):
        captured.append(kwargs)
        return {"generated_text": replies[0], "usage": {"prompt_tokens": 1}}

    monkeypatch.setattr(ep, "run_openai_compatible_chat", fake_chat)
    runtime = module.OpenAICompatibleRuntime("local_openai")
    return SimpleNamespace(
        module=module, runtime=runtime, captured=captured, replies=replies, runtime_module=runtime_module, ep=ep
    )


def _request(fx, text="hi", **overrides):
    values = dict(
        model_id="m",
        messages=[{"role": "user", "content": text}],
        response_schema={
            "type": "json_schema",
            "json_schema": {
                "name": "s",
                "strict": True,
                "schema": {"type": "object", "properties": {"reply": {"type": "string"}}},
            },
        },
        session_key="s:0",
        base_instructions="BASE",
        developer_instructions="DEV",
        connection=fx.runtime_module.RuntimeConnection(
            base_url="http://x/v1", api_key="k", temperature=0.1, max_tokens=900
        ),
    )
    values.update(overrides)
    return fx.runtime_module.StepRequest(**values)


def test_openai_runtime_sends_system_prompt_strict_schema_and_step_token_floor(openai_runtime) -> None:
    openai_runtime.runtime.run_step(_request(openai_runtime))

    sent = openai_runtime.captured[0]
    assert sent["messages"][0] == {"role": "system", "content": "BASE\n\nDEV"}
    assert sent["max_tokens"] == openai_runtime.runtime.STEP_MIN_MAX_TOKENS
    schema = sent["response_format"]["json_schema"]["schema"]
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["reply"]
    assert sent["base_url"] == "http://x/v1" and sent["api_key"] == "k"


def test_openai_runtime_replays_history_and_persists_assistant_replies(openai_runtime) -> None:
    first = openai_runtime.runtime.run_step(_request(openai_runtime, "one"))
    openai_runtime.runtime.run_step(_request(openai_runtime, "two", provider_state=first.provider_state))

    roles = [item["role"] for item in openai_runtime.captured[1]["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    stored = json.loads(
        (openai_runtime.module.transcripts_dir() / f"{first.provider_state}.json").read_text()
    )
    assert [item["role"] for item in stored["messages"]] == ["user", "assistant", "user", "assistant"]


def test_openai_runtime_replaces_transcript_when_instructions_or_session_change(openai_runtime) -> None:
    first = openai_runtime.runtime.run_step(_request(openai_runtime))

    changed = openai_runtime.runtime.run_step(
        _request(openai_runtime, provider_state=first.provider_state, developer_instructions="NEW")
    )
    other_session = openai_runtime.runtime.run_step(
        _request(openai_runtime, provider_state=first.provider_state, session_key="other:0")
    )

    assert changed.provider_state != first.provider_state and "thread_replaced" in changed.lifecycle
    assert other_session.provider_state != first.provider_state


def test_openai_runtime_accepts_fenced_json_and_rejects_invalid_json_without_persisting(openai_runtime) -> None:
    openai_runtime.replies[0] = '```json\n{"reply":"fenced"}\n```'
    ok = openai_runtime.runtime.run_step(_request(openai_runtime))
    assert json.loads(ok.text) == {"reply": "fenced"}

    openai_runtime.replies[0] = "not json at all"
    before = len(list(openai_runtime.module.transcripts_dir().glob("*.json")))
    with pytest.raises(openai_runtime.ep.EnhancementProviderError, match="valid JSON"):
        openai_runtime.runtime.run_step(_request(openai_runtime, provider_state=ok.provider_state))
    assert len(list(openai_runtime.module.transcripts_dir().glob("*.json"))) == before
    stored = json.loads((openai_runtime.module.transcripts_dir() / f"{ok.provider_state}.json").read_text())
    assert len(stored["messages"]) == 2


def test_openai_runtime_requires_an_endpoint(openai_runtime) -> None:
    with pytest.raises(openai_runtime.ep.EnhancementProviderError, match="no endpoint"):
        openai_runtime.runtime.run_step(
            _request(openai_runtime, connection=openai_runtime.runtime_module.RuntimeConnection())
        )


def test_openai_runtime_ignores_path_like_state_ids(openai_runtime) -> None:
    result = openai_runtime.runtime.run_step(_request(openai_runtime, provider_state="../../etc/passwd"))

    assert "thread_replaced" in result.lifecycle
    assert openai_runtime.runtime.archive_session("s:0", "../../etc/passwd") is False


def test_openai_runtime_compaction_drops_oldest_messages(openai_runtime) -> None:
    runtime = openai_runtime.runtime
    runtime.COMPACTION_CHAR_BUDGET = 200
    state = None
    for index in range(4):
        state = runtime.run_step(_request(openai_runtime, f"m{index}" + "y" * 120, provider_state=state)).provider_state

    result = runtime.run_step(_request(openai_runtime, "now", provider_state=state, compact_before_turn=True))

    assert result.compaction["strategy"] == "drop_oldest_turns"
    assert result.compaction["dropped_messages"] > 0


def test_openai_runtime_compaction_callback_brackets_the_trim(openai_runtime) -> None:
    events: List[bool] = []
    state = openai_runtime.runtime.run_step(_request(openai_runtime)).provider_state

    openai_runtime.runtime.run_step(
        _request(openai_runtime, provider_state=state, compact_before_turn=True, on_compaction=events.append)
    )

    assert events == [True, False]


# -- registry and feature flag ----------------------------------------------------


def test_experimental_runtimes_are_off_by_default(app_modules) -> None:
    del app_modules
    runtime_module = importlib.import_module("app.assistant_runtime")

    assert runtime_module.get_assistant_runtime("codex_local") is not None
    assert runtime_module.get_assistant_runtime("local_openai") is None
    assert runtime_module.get_assistant_runtime("openrouter") is None
    assert runtime_module.runtime_supports_kernel("local_openai") is False


def test_experimental_runtimes_register_only_when_flagged(app_modules, monkeypatch) -> None:
    del app_modules
    settings_module = importlib.import_module("app.settings")
    monkeypatch.setattr(
        settings_module.settings, "media_assistant_experimental_runtimes", ("local_openai", "bogus"), raising=False
    )
    runtime_module = importlib.import_module("app.assistant_runtime")

    assert runtime_module.runtime_supports_kernel("local_openai") is True
    assert runtime_module.get_assistant_runtime("bogus") is None
    assert runtime_module.get_assistant_runtime("openrouter") is None
    assert runtime_module.runtime_supports_vision("local_openai") is False


def test_flag_is_parsed_from_the_environment(monkeypatch) -> None:
    import sys

    monkeypatch.setenv("MEDIA_ASSISTANT_EXPERIMENTAL_RUNTIMES", " local_openai , openrouter ,")
    for name in sorted([key for key in sys.modules if key == "app" or key.startswith("app.")], reverse=True):
        sys.modules.pop(name, None)
    settings_module = importlib.import_module("app.settings")

    assert settings_module.settings.media_assistant_experimental_runtimes == ("local_openai", "openrouter")


def test_transcripts_are_not_served_by_the_media_file_endpoint(app_modules) -> None:
    openai_module = importlib.import_module("app.assistant_runtime.openai_compatible")
    main = app_modules["main"]
    transcript = openai_module.transcripts_dir() / "transcript_secret.json"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text("{}")

    assert main._resolve_media_file_path(str(transcript)) is None
    assert main._resolve_media_file_path("runtime/assistant-transcripts/transcript_secret.json") is None


def _use_merge(monkeypatch, *, key="mg_test", base="https://api-gateway.merge.dev/v1"):
    settings_module = importlib.import_module("app.settings")
    for name, value in {
        "media_assistant_provider": "merge_gateway",
        "merge_api_key": key,
        "merge_model": "anthropic/claude-haiku-5-5",
        "merge_base_url": base,
    }.items():
        monkeypatch.setattr(settings_module.settings, name, value, raising=False)


def test_merge_gateway_is_selected_from_the_environment(app_modules, monkeypatch) -> None:
    del app_modules
    _use_merge(monkeypatch)
    support = importlib.import_module("app.assistant.provider_support")
    runtime_module = importlib.import_module("app.assistant_runtime")

    resolved = support.resolve_assistant_provider_runtime({"provider_kind": "codex_local", "provider_model_id": "gpt-x"})

    assert resolved.provider_kind == "merge_gateway"
    assert resolved.provider_model_id == "anthropic/claude-haiku-5-5"  # env wins over a stored Codex model
    assert resolved.provider_base_url == "https://api-gateway.merge.dev/v1/openai"  # /v1 is normalised
    assert resolved.api_key == "mg_test"
    assert support.configured_assistant_provider({}) == ("merge_gateway", "anthropic/claude-haiku-5-5")
    assert runtime_module.runtime_supports_kernel("merge_gateway") is True
    assert runtime_module.runtime_supports_vision("merge_gateway") is True


def test_merge_gateway_without_a_key_is_a_configuration_error(app_modules, monkeypatch) -> None:
    del app_modules
    _use_merge(monkeypatch, key=None)
    support = importlib.import_module("app.assistant.provider_support")

    with pytest.raises(support.AssistantProviderConfigurationError):
        support.resolve_assistant_provider_runtime({})


def test_unset_override_keeps_codex_local(app_modules) -> None:
    del app_modules
    support = importlib.import_module("app.assistant.provider_support")
    runtime_module = importlib.import_module("app.assistant_runtime")

    assert support.configured_assistant_provider({})[0] == "codex_local"
    assert runtime_module.get_assistant_runtime("merge_gateway") is None


def test_runtime_readiness_follows_the_selected_runtime(app_modules, monkeypatch) -> None:
    del app_modules
    env_providers = importlib.import_module("app.assistant_runtime.env_providers")

    assert env_providers.assistant_runtime_readiness(True) == {"kind": "codex_local", "ready": True}
    assert env_providers.assistant_runtime_readiness(False) == {"kind": "codex_local", "ready": False}
    _use_merge(monkeypatch)
    assert env_providers.assistant_runtime_readiness(False) == {"kind": "merge_gateway", "ready": True}
    _use_merge(monkeypatch, key=None)
    assert env_providers.assistant_runtime_readiness(True) == {"kind": "merge_gateway", "ready": False}


def test_health_reports_assistant_runtime_readiness(client, app_modules, monkeypatch) -> None:
    del app_modules
    _use_merge(monkeypatch)

    payload = client.get("/health").json()

    assert payload["media_assistant_runtime"] == "merge_gateway"
    assert payload["media_assistant_runtime_ready"] is True


def test_strict_response_format_inlines_refs(app_modules) -> None:
    del app_modules
    openai_module = importlib.import_module("app.assistant_runtime.openai_compatible")
    kernel = importlib.import_module("app.assistant.kernel")

    schema = openai_module._strict_response_format(kernel._provider_step_schema())["json_schema"]["schema"]

    assert "$ref" not in json.dumps(schema)
    assert "$defs" not in schema
    assert schema["properties"]["capability"].get("enum")


def test_inline_refs_leaves_cycles_unconstrained(app_modules) -> None:
    del app_modules
    openai_module = importlib.import_module("app.assistant_runtime.openai_compatible")
    defs = {"Node": {"type": "object", "properties": {"child": {"$ref": "#/$defs/Node"}}}}

    flat = openai_module._inline_refs({"$ref": "#/$defs/Node"}, defs)

    assert flat["properties"]["child"] == {}


def test_kernel_tool_results_are_sent_as_user_messages(app_modules) -> None:
    del app_modules
    openai_module = importlib.import_module("app.assistant_runtime.openai_compatible")

    assert openai_module._wire_message({"role": "tool", "content": "result"}) == {"role": "user", "content": "result"}
    assert openai_module._wire_message({"role": "assistant", "content": "x"}) == {"role": "assistant", "content": "x"}


def test_anthropic_schema_drops_size_keywords_but_keeps_a_hint(app_modules) -> None:
    del app_modules
    openai_module = importlib.import_module("app.assistant_runtime.openai_compatible")
    kernel = importlib.import_module("app.assistant.kernel")
    schema_in = kernel._provider_step_schema()

    stripped = json.dumps(openai_module._strict_response_format(schema_in, strip_constraints=True))
    kept = json.dumps(openai_module._strict_response_format(schema_in))

    for keyword in ("maxItems", "maxLength", "minLength"):
        assert f'"{keyword}"' not in stripped
    assert '"maxLength"' in kept  # other providers keep the limits
    assert "Limits: maxLength=1200" in stripped


def test_merge_gateway_runtime_strips_constraints_others_do_not(app_modules, monkeypatch) -> None:
    del app_modules
    _use_merge(monkeypatch)
    runtime_module = importlib.import_module("app.assistant_runtime")
    openai_module = importlib.import_module("app.assistant_runtime.openai_compatible")
    openai_module.register_experimental_runtimes(("local_openai",))

    assert runtime_module.get_assistant_runtime("merge_gateway").strip_constraints is True
    assert runtime_module.get_assistant_runtime("local_openai").strip_constraints is False


def test_prompt_cache_marks_the_system_prompt_only_when_enabled(openai_runtime) -> None:
    plain = openai_runtime.runtime
    cached = openai_runtime.module.OpenAICompatibleRuntime("merge_gateway", prompt_cache=True)

    plain.run_step(_request(openai_runtime))
    cached.run_step(_request(openai_runtime, session_key="s:1"))

    assert openai_runtime.captured[0]["messages"][0] == {"role": "system", "content": "BASE\n\nDEV"}
    block = openai_runtime.captured[1]["messages"][0]["content"][0]
    assert block == {"type": "text", "text": "BASE\n\nDEV", "cache_control": {"type": "ephemeral"}}


def test_merge_gateway_runtime_enables_prompt_cache(app_modules, monkeypatch) -> None:
    del app_modules
    _use_merge(monkeypatch)
    runtime_module = importlib.import_module("app.assistant_runtime")

    assert runtime_module.get_assistant_runtime("merge_gateway").prompt_cache is True


def _turns(count: int, size: int = 100):
    messages = []
    for index in range(count):
        messages += [
            {"role": "user", "content": f"u{index}" + "x" * size},
            {"role": "assistant", "content": "a" * size},
            {"role": "tool", "content": "t" * size},
            {"role": "assistant", "content": "done"},
        ]
    return messages


def test_compaction_cuts_on_turn_boundaries_and_trims_below_the_budget(openai_runtime) -> None:
    runtime = openai_runtime.runtime
    runtime.COMPACTION_CHAR_BUDGET = 2000
    messages = _turns(8)

    kept, outcome = runtime._compact(messages)

    assert kept[0]["role"] == "user"
    assert kept[-1] == messages[-1]
    assert len(json.dumps(kept, separators=(",", ":"))) <= 2000 * runtime.COMPACTION_TARGET_RATIO
    assert outcome["dropped_messages"] == len(messages) - len(kept)
    assert (len(messages) - len(kept)) % 4 == 0  # whole turns only


def test_compaction_leaves_room_so_the_next_turn_does_not_recompact(openai_runtime) -> None:
    runtime = openai_runtime.runtime
    runtime.COMPACTION_CHAR_BUDGET = 2000
    kept, _ = runtime._compact(_turns(8))

    again, outcome = runtime._compact([*kept, *_turns(1)])

    assert outcome is None and len(again) == len(kept) + 4


def test_compaction_never_cuts_the_only_turn(openai_runtime) -> None:
    runtime = openai_runtime.runtime
    runtime.COMPACTION_CHAR_BUDGET = 50
    messages = _turns(1, size=400)

    kept, outcome = runtime._compact(messages)

    assert kept == messages and outcome is None


def _flaky_chat(openai_runtime, monkeypatch, outcomes):
    calls = []

    def fake(**kwargs):
        calls.append(kwargs)
        outcome = outcomes[min(len(calls) - 1, len(outcomes) - 1)]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(openai_runtime.ep, "run_openai_compatible_chat", fake)
    monkeypatch.setattr(importlib.import_module("app.assistant_runtime.resilience"), "BACKOFF_SECONDS", (0, 0))
    return calls


def _http_error(openai_runtime, status):
    error = openai_runtime.ep.EnhancementProviderError(f"failed with {status}.")
    error.status_code = status
    return error


def test_transient_failures_are_retried(openai_runtime, monkeypatch) -> None:
    ok = {"generated_text": '{"reply":"ok"}', "usage": {}}
    calls = _flaky_chat(openai_runtime, monkeypatch, [_http_error(openai_runtime, 504), _http_error(openai_runtime, 429), ok])

    result = openai_runtime.runtime.run_step(_request(openai_runtime))

    assert len(calls) == 3
    assert json.loads(result.text) == {"reply": "ok"}


def test_client_errors_are_not_retried(openai_runtime, monkeypatch) -> None:
    calls = _flaky_chat(openai_runtime, monkeypatch, [_http_error(openai_runtime, 400)])

    with pytest.raises(openai_runtime.ep.EnhancementProviderError):
        openai_runtime.runtime.run_step(_request(openai_runtime))

    assert len(calls) == 1


def test_retries_give_up_and_state_does_not_advance(openai_runtime, monkeypatch) -> None:
    calls = _flaky_chat(openai_runtime, monkeypatch, [_http_error(openai_runtime, 503)])

    with pytest.raises(openai_runtime.ep.EnhancementProviderError):
        openai_runtime.runtime.run_step(_request(openai_runtime))

    assert len(calls) == 3
    assert not list(openai_runtime.module.transcripts_dir().glob("*.json"))


def test_connection_errors_become_provider_errors_after_retries(openai_runtime, monkeypatch) -> None:
    import httpx

    calls = _flaky_chat(openai_runtime, monkeypatch, [httpx.ConnectError("boom")])

    with pytest.raises(openai_runtime.ep.EnhancementProviderError, match="could not be reached"):
        openai_runtime.runtime.run_step(_request(openai_runtime))

    assert len(calls) == 3


def test_cancel_stops_retrying(openai_runtime, monkeypatch) -> None:
    cancel = threading.Event()
    cancel.set()
    resilience = importlib.import_module("app.assistant_runtime.resilience")
    attempts = []

    def failing():
        attempts.append(1)
        raise _http_error(openai_runtime, 503)

    with pytest.raises(openai_runtime.ep.EnhancementProviderError):
        resilience.call_with_retries(failing, cancel_event=cancel)

    assert len(attempts) == 1
