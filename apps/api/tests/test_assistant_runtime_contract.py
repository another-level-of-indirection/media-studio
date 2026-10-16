"""Behavioral contract every ``AssistantRuntime`` must satisfy.

Each runtime supplies a harness that fakes only its backend (the Codex App
Server wrapper, or the OpenAI-compatible HTTP call). The contract tests then
drive the real runtime adapter through ``run_step``. To add a runtime, add a
harness class and list it in ``HARNESSES``; it must pass every test here.
"""

from __future__ import annotations

import importlib
import json
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

STEP_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "contract_step",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"reply": {"type": "string"}},
            "required": ["reply"],
        },
    },
}


def _texts(messages: List[Dict[str, Any]]) -> str:
    return "\n".join(str(item.get("content")) for item in messages)


class _HarnessBase:
    kind = ""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.replies: List[str] = []
        self.fail_message: Optional[str] = None
        self.hang = False
        self.minimal = False
        self.compaction_next = False
        self.archived: List[str] = []
        self.closed: List[str] = []
        self.release = threading.Event()

    # Contract-facing controls ------------------------------------------------
    def script(self, *replies: str) -> None:
        self.replies.extend(replies)

    def next_reply(self) -> str:
        return self.replies.pop(0) if self.replies else '{"reply":"ok"}'

    def teardown(self) -> None:
        self.release.set()


class CodexHarness(_HarnessBase):
    kind = "codex_local"

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        super().__init__()
        self.ep = importlib.import_module("app.enhancement_provider")
        self.cl = self.ep.codex_local_provider
        self.threads: Dict[str, List[str]] = {}
        runtime_module = importlib.import_module("app.assistant_runtime")
        self.runtime = runtime_module.get_assistant_runtime(self.kind)
        monkeypatch.setattr(self.ep, "run_codex_local_chat", self._chat)
        monkeypatch.setattr(self.cl, "close_codex_local_skill_session", self.closed.append)
        monkeypatch.setattr(self.cl, "archive_codex_local_thread", self._archive)

    def _archive(self, *, session_key: str, thread_id: str) -> bool:
        self.archived.append(thread_id)
        return thread_id in self.threads

    def _chat(self, **kwargs: Any) -> Dict[str, Any]:
        record: Dict[str, Any] = {"stateless": "codex_session_key" not in kwargs, "kwargs": kwargs}
        self.calls.append(record)
        if self.fail_message:
            raise self.ep.EnhancementProviderError(self.fail_message)
        if self.hang:
            event = kwargs["cancel_event"]
            deadline = time.monotonic() + 5
            while not event.is_set() and time.monotonic() < deadline:
                time.sleep(0.02)
            raise self.ep.EnhancementProviderError("Codex Local turn was interrupted.") from (
                self.cl.CodexLocalProviderCancelled("interrupted")
            )
        text = self.next_reply()
        if self.minimal:
            return {"generated_text": text}
        lifecycle: List[str] = []
        thread = None
        if not record["stateless"]:
            requested = kwargs.get("provider_thread_id")
            if requested and requested in self.threads:
                thread = requested
                lifecycle = ["thread_resumed"]
            else:
                thread = f"thread-{len(self.threads) + 1}"
                self.threads[thread] = []
                lifecycle = (
                    ["thread_resume_failed", "fallback_hydrated", "thread_replaced"]
                    if requested
                    else ["thread_started"]
                )
            self.threads[thread].append(_texts(kwargs["messages"]))
            record["visible"] = "\n".join(self.threads[thread])
            self.threads[thread].append(text)
        result: Dict[str, Any] = {
            "generated_text": text,
            "provider_thread_id": thread,
            "provider_turn_id": "turn-1",
            "thread_lifecycle": lifecycle,
            "process_lifecycle": "process_spawned",
            "usage": {"prompt_tokens": 5, "total_tokens": 7},
            "latency_ms": 1,
        }
        if self.compaction_next and kwargs.get("compact_before_turn"):
            result["compaction"] = {"outcome": "completed", "count": 1}
            self.compaction_next = False
        return result

    def state_footprint(self) -> int:
        return len(self.threads)


class OpenAIHarness(_HarnessBase):
    kind = "local_openai"

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        super().__init__()
        self.ep = importlib.import_module("app.enhancement_provider")
        self.module = importlib.import_module("app.assistant_runtime.openai_compatible")
        runtime_module = importlib.import_module("app.assistant_runtime")
        self.runtime = self.module.OpenAICompatibleRuntime(self.kind)
        runtime_module.register_runtime(self.runtime)
        monkeypatch.setattr(self.ep, "run_openai_compatible_chat", self._chat)

    def _chat(self, **kwargs: Any) -> Dict[str, Any]:
        outbound = kwargs["messages"]
        self.calls.append({"outbound": outbound, "kwargs": kwargs, "visible": json.dumps(outbound)})
        if self.fail_message:
            raise self.ep.EnhancementProviderError(self.fail_message)
        if self.hang:
            self.release.wait(5)
            raise self.ep.EnhancementProviderError("released")
        text = self.next_reply()
        if self.minimal:
            return {"generated_text": text}
        return {"generated_text": text, "usage": {"prompt_tokens": 5, "total_tokens": 7}}

    def force_compaction(self) -> None:
        self.runtime.COMPACTION_CHAR_BUDGET = 50

    def state_footprint(self) -> int:
        directory = self.module.transcripts_dir()
        return len(list(directory.glob("*.json"))) if directory.exists() else 0


# Codex fakes its own compaction; the OpenAI runtime needs a tiny budget.
def _arm_compaction(harness: _HarnessBase) -> None:
    if isinstance(harness, OpenAIHarness):
        harness.force_compaction()
    else:
        harness.compaction_next = True


HARNESSES = {"codex_local": CodexHarness, "local_openai": OpenAIHarness}


@pytest.fixture(params=sorted(HARNESSES))
def harness(request, app_modules, monkeypatch):
    del app_modules
    instance = HARNESSES[request.param](monkeypatch)
    yield instance
    instance.teardown()


def make_request(harness: _HarnessBase, text: str = "hello", **overrides: Any):
    runtime_module = importlib.import_module("app.assistant_runtime")
    values: Dict[str, Any] = dict(
        model_id="contract-model",
        messages=[{"role": "user", "content": text}],
        response_schema=STEP_SCHEMA,
        session_key="session-a:0",
        base_instructions="base",
        developer_instructions="developer",
        connection=runtime_module.RuntimeConnection(base_url="http://127.0.0.1:9/v1", api_key="k"),
    )
    values.update(overrides)
    return runtime_module.StepRequest(**values)


# -- contract -------------------------------------------------------------------


def test_runtime_is_registered_and_declares_kernel_capabilities(harness) -> None:
    runtime_module = importlib.import_module("app.assistant_runtime")
    assert runtime_module.get_assistant_runtime(harness.kind) is harness.runtime
    assert harness.runtime.kind == harness.kind
    assert harness.runtime.capabilities.structured_output is True
    assert runtime_module.runtime_supports_kernel(harness.kind) is True
    assert isinstance(harness.runtime, runtime_module.AssistantRuntime)


def test_step_returns_schema_json_and_normalized_result(harness) -> None:
    runtime_module = importlib.import_module("app.assistant_runtime")
    harness.script('{"reply":"hi"}')

    result = harness.runtime.run_step(make_request(harness))

    assert isinstance(result, runtime_module.StepResult)
    assert json.loads(result.text) == {"reply": "hi"}
    assert result.provider_state
    assert isinstance(result.usage, dict) and result.usage.get("prompt_tokens") == 5
    assert isinstance(result.lifecycle, list)


def test_stateful_steps_resume_and_keep_prior_context(harness) -> None:
    first = harness.runtime.run_step(make_request(harness, "remember-the-lighthouse"))
    second = harness.runtime.run_step(
        make_request(harness, "what did I say?", provider_state=first.provider_state)
    )

    assert second.provider_state == first.provider_state
    assert "remember-the-lighthouse" in harness.calls[-1]["visible"]
    assert "thread_resumed" in second.lifecycle


def test_unknown_provider_state_is_replaced_not_fatal(harness) -> None:
    result = harness.runtime.run_step(make_request(harness, provider_state="stale-state-id"))

    assert result.provider_state and result.provider_state != "stale-state-id"
    assert "thread_replaced" in result.lifecycle


def test_stateless_step_creates_no_session_state(harness) -> None:
    before = harness.state_footprint()

    result = harness.runtime.run_step(make_request(harness, session_key=None))

    assert json.loads(result.text)
    assert result.provider_state is None
    assert harness.state_footprint() == before


def test_provider_failure_raises_runtime_step_error(harness) -> None:
    runtime_module = importlib.import_module("app.assistant_runtime")
    harness.fail_message = "backend exploded"

    with pytest.raises(runtime_module.RuntimeStepError) as caught:
        harness.runtime.run_step(make_request(harness))

    assert "backend exploded" in str(caught.value)
    assert harness.runtime.was_interrupted(caught.value) is False


def test_stop_interrupts_the_step_and_is_distinguishable(harness) -> None:
    runtime_module = importlib.import_module("app.assistant_runtime")
    harness.hang = True
    cancel = threading.Event()
    threading.Timer(0.2, cancel.set).start()

    started = time.monotonic()
    with pytest.raises(runtime_module.RuntimeStepError) as caught:
        harness.runtime.run_step(make_request(harness, cancel_event=cancel, unbounded=True))

    assert time.monotonic() - started < 4
    assert harness.runtime.was_interrupted(caught.value) is True


def test_failed_step_does_not_advance_conversation_state(harness) -> None:
    runtime_module = importlib.import_module("app.assistant_runtime")
    first = harness.runtime.run_step(make_request(harness, "keep-this"))
    harness.fail_message = "transient"
    with pytest.raises(runtime_module.RuntimeStepError):
        harness.runtime.run_step(make_request(harness, "lost-message", provider_state=first.provider_state))
    harness.fail_message = None

    harness.runtime.run_step(make_request(harness, "retry", provider_state=first.provider_state))

    visible = harness.calls[-1]["visible"]
    assert "keep-this" in visible
    if not harness.runtime.capabilities.provider_managed_state:
        # Adapter-managed state must not persist a message whose step failed.
        assert "lost-message" not in visible


def test_compaction_request_reports_an_honest_outcome(harness) -> None:
    assert harness.runtime.capabilities.compaction is True
    state = None
    for index in range(3):
        state = harness.runtime.run_step(
            make_request(harness, f"turn-{index}-" + "x" * 80, provider_state=state)
        ).provider_state
    _arm_compaction(harness)

    result = harness.runtime.run_step(
        make_request(harness, "after", provider_state=state, compact_before_turn=True)
    )

    assert result.compaction is not None
    assert result.compaction["outcome"] == "completed"


def test_missing_optional_provider_fields_are_tolerated(harness) -> None:
    harness.minimal = True

    result = harness.runtime.run_step(make_request(harness, session_key=None))

    assert json.loads(result.text)
    assert result.usage == {}
    assert result.compaction is None


def test_archive_and_close_session_follow_the_contract(harness) -> None:
    state = harness.runtime.run_step(make_request(harness)).provider_state

    assert harness.runtime.archive_session("session-a:0", "never-existed") is False
    assert harness.runtime.archive_session("session-a:0", state) is True
    harness.runtime.close_session("session-a:0")  # must never raise
