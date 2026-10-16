# Python 3.14: `importlib_resources` / `Traversable` import failure

## Summary

On Python 3.14, `kie_api` could not be imported. The Media Studio API still
started and answered `/health`, but anything that needed `kie_api` failed.

## Symptoms

Seen when running `./scripts/run_studio_mac.sh` on Python 3.14 (Homebrew):

```text
KIE model startup diagnostics failed: No module named 'importlib_resources'
KIE credit balance check failed: No module named 'importlib_resources'
GET /media/models HTTP/1.1" 500 Internal Server Error
ModuleNotFoundError: No module named 'importlib_resources'
```

Affected:

- `GET /media/models` returned 500, so the model list did not load in Studio.
- Startup diagnostics failed.
- The KIE credit balance check failed. `/media/credits` still returned 200
  with a degraded result.

Endpoints that don't use `kie_api` (`/health`, `/media/assets`,
`/media/jobs`, and so on) kept working.

## Root cause

The failing code is in the sibling `kie-api` repo, in
`src/kie_api/registry/loader.py`:

```python
try:
    from importlib.abc import Traversable
except ImportError:
    from importlib_resources.abc import Traversable
```

`importlib.abc.Traversable` was deprecated in Python 3.12 and removed in 3.14.
The first import raised `ImportError`. The fallback imported the third-party
`importlib_resources` package, which is not a declared dependency and was not
installed. That raised `ModuleNotFoundError`, which broke `import kie_api` for
every caller. `apps/api/app/kie_adapter.py` imports `kie_api` lazily, so the
error only appeared when an endpoint first used it.

## Fix

In `kie-api/src/kie_api/registry/loader.py`, try the current location first
(`importlib.resources.abc`, available since Python 3.11). Keep the older
locations as fallbacks:

```python
try:
    # Python 3.11+ (importlib.abc.Traversable was removed in 3.14)
    from importlib.resources.abc import Traversable
except ImportError:  # older Python fallbacks
    try:
        from importlib.abc import Traversable
    except ImportError:
        from importlib_resources.abc import Traversable
```

No new dependency is needed.

## Verification

From the `kie-api` venv:

```bash
cd ../kie-api
.venv/bin/python -c "import kie_api; kie_api.load_registry(); print('ok')"
```

Then restart `./scripts/run_studio_mac.sh`. `GET /media/models` should return
200 and the startup and credit warnings should be gone.

## Notes

- The change lives in the `kie-api` repo, not `media-studio`. Commit it there.
- Any `kie-api` checkout older than this fix will fail the same way on
  Python 3.14.
