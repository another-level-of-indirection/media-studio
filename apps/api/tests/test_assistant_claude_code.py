"""Claude Code runtime, exercised against a fake ``claude`` executable (no network, no account)."""

from __future__ import annotations

import importlib
import json
import stat
import sys
import threading
import time
from pathlib import Path

import pytest

FAKE_CLI = """#!{python}
import json, os, sys, time
argv = sys.argv[1:]
if argv[:2] == ["auth", "status"]:
    print(json.dumps({{"loggedIn": os.environ.get("FAKE_LOGGED_IN", "1") == "1"}}))
    sys.exit(0)
message = json.loads(sys.stdin.readline())["message"]["content"]
prompt = "\\n".join(b["text"] for b in message if b["type"] == "text")
images = [b for b in message if b["type"] == "image"]
open(os.environ["FAKE_LOG"], "w").write(json.dumps({{"argv": argv, "prompt": prompt, "images": images, "cwd": os.getcwd()}}))
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "sleep":
    time.sleep(30)
if mode == "auth":
    print(json.dumps({{"type": "result", "is_error": True, "result": "Failed to authenticate: OAuth session expired"}}))
elif mode == "overloaded":
    print(json.dumps({{"type": "result", "is_error": True, "api_error_status": 529, "result": "Overloaded"}}))
else:
    print(json.dumps({{"type": "result", "is_error": False, "structured_output": {{"reply": "hello"}},
        "result": "", "total_cost_usd": 0.01,
        "usage": {{"input_tokens": 3, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 7, "output_tokens": 5}}}}))
"""

SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "s",
        "strict": True,
        "schema": {"type": "object", "properties": {"reply": {"type": "string", "maxLength": 10}}},
    },
}


@pytest.fixture()
def fake_cli(app_modules, monkeypatch, tmp_path):
    del app_modules
    binary = tmp_path / "claude"
    binary.write_text(FAKE_CLI.format(python=sys.executable))
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "call.json"
    monkeypatch.setenv("FAKE_LOG", str(log))
    settings = importlib.import_module("app.settings").settings
    monkeypatch.setattr(settings, "claude_code_bin", str(binary), raising=False)
    monkeypatch.setattr(settings, "media_assistant_provider", "claude_code", raising=False)
    monkeypatch.setattr(settings, "data_root", tmp_path, raising=False)
    module = importlib.import_module("app.assistant_runtime.claude_code")
    module._auth_cache.update(at=0.0, value=None)
    monkeypatch.setattr(module.time, "sleep", lambda _s: None, raising=False)  # no retry backoff delay
    return module, log


def _request(**overrides):
    package = importlib.import_module("app.assistant_runtime")
    values = dict(
        model_id="sonnet",
        messages=[{"role": "user", "content": "hi there"}],
        response_schema=SCHEMA,
        session_key="s:0",
        base_instructions="BASE RULES",
        developer_instructions="DEV RULES",
        connection=package.RuntimeConnection(base_url=None, api_key=None, temperature=0.1, max_tokens=900),
    )
    values.update(overrides)
    return package.StepRequest(**values)


def _runtime():
    from app.assistant_runtime import get_assistant_runtime
    from app.assistant_runtime.openai_compatible import register_experimental_runtimes

    register_experimental_runtimes()
    return get_assistant_runtime("claude_code")


def test_step_runs_a_locked_down_cli_and_maps_the_result(fake_cli) -> None:
    _, log = fake_cli
    runtime = _runtime()

    result = runtime.run_step(_request())

    call = json.loads(log.read_text())
    argv = call["argv"]
    assert json.loads(result.text) == {"reply": "hello"}
    assert argv[0] == "-p" and argv[argv.index("--input-format") + 1] == "stream-json"
    assert "--no-session-persistence" in argv and "--restricted" in argv
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--model") + 1] == "sonnet"
    schema = json.loads(argv[argv.index("--json-schema") + 1])
    assert schema["additionalProperties"] is False and "maxLength" not in schema["properties"]["reply"]
    assert "BASE RULES" in argv[argv.index("--system-prompt") + 1] and "hi there" in call["prompt"]
    assert "BASE RULES" not in call["prompt"]
    assert "claude-code-cwd" in call["cwd"]
    assert result.usage["prompt_tokens"] == 110 and result.usage["completion_tokens"] == 5
    assert result.usage["cost"] == 0.01
    assert runtime.capabilities.vision is True


def test_transcript_is_replayed_on_the_next_step(fake_cli) -> None:
    _, log = fake_cli
    runtime = _runtime()
    first = runtime.run_step(_request())

    runtime.run_step(_request(messages=[{"role": "user", "content": "second question"}], provider_state=first.provider_state))

    prompt = json.loads(log.read_text())["prompt"]
    assert "hi there" in prompt and '"reply":"hello"' in prompt and "second question" in prompt


def test_expired_login_is_reported_plainly_and_not_retried(fake_cli, monkeypatch) -> None:
    monkeypatch.setenv("FAKE_MODE", "auth")
    runtime = _runtime()

    with pytest.raises(Exception) as caught:
        runtime.run_step(_request())

    assert "claude auth login" in str(caught.value)


def test_overloaded_responses_are_retried_then_surface(fake_cli, monkeypatch) -> None:
    module, log = fake_cli
    monkeypatch.setenv("FAKE_MODE", "overloaded")
    calls = []
    original = module._run_cli
    monkeypatch.setattr(module, "_run_cli", lambda *a, **k: calls.append(1) or original(*a, **k))
    runtime = _runtime()

    with pytest.raises(Exception):
        runtime.run_step(_request())

    assert len(calls) == 3


def test_stop_kills_the_process(fake_cli, monkeypatch) -> None:
    monkeypatch.setenv("FAKE_MODE", "sleep")
    runtime = _runtime()
    cancel = threading.Event()
    threading.Timer(0.5, cancel.set).start()
    started = time.monotonic()

    with pytest.raises(Exception) as caught:
        runtime.run_step(_request(cancel_event=cancel))

    assert runtime.was_interrupted(caught.value)
    assert time.monotonic() - started < 10


def test_readiness_follows_sign_in(fake_cli, monkeypatch) -> None:
    module, _ = fake_cli
    env_providers = importlib.import_module("app.assistant_runtime.env_providers")

    assert env_providers.assistant_runtime_readiness(False) == {"kind": "claude_code", "ready": True}
    module._auth_cache.update(at=0.0, value=None)
    monkeypatch.setenv("FAKE_LOGGED_IN", "0")
    assert env_providers.assistant_runtime_readiness(False) == {"kind": "claude_code", "ready": False}


def test_provider_needs_no_key_and_defaults_to_sonnet(fake_cli) -> None:
    support = importlib.import_module("app.assistant.provider_support")

    resolved = support.resolve_assistant_provider_runtime({"provider_kind": "codex_local", "provider_model_id": "gpt-x"})

    assert (resolved.provider_kind, resolved.provider_model_id, resolved.api_key) == ("claude_code", "sonnet", None)


def test_oversized_instructions_ride_on_stdin_off_macos(fake_cli, monkeypatch) -> None:
    module, log = fake_cli
    monkeypatch.setattr(module.sys, "platform", "linux")
    monkeypatch.setattr(module, "_SYSTEM_ARG_LIMIT", 5)

    _runtime().run_step(_request())

    call = json.loads(log.read_text())
    assert "BASE RULES" in call["prompt"] and "BASE RULES" not in json.dumps(call["argv"])


def test_images_are_sent_as_content_blocks_in_place(fake_cli) -> None:
    _, log = fake_cli
    content = [
        {"type": "text", "text": "what is this?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}},
        {"type": "image_url", "image_url": {"url": "https://example.test/a.jpg"}},
        {"type": "image_url", "image_url": {"url": "file:///etc/passwd"}},
    ]

    _runtime().run_step(_request(messages=[{"role": "user", "content": content}]))

    call = json.loads(log.read_text())
    assert call["images"] == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}},
        {"type": "image", "source": {"type": "url", "url": "https://example.test/a.jpg"}},
    ]
    assert "[image could not be attached]" in call["prompt"] and "what is this?" in call["prompt"]
