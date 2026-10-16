# Media Studio documentation

Media Studio owns the local application, library, presets and visual workflows. Its companion KIE provider project supplies media-provider integration and model metadata. Start with the [product overview](../README.md) for supported categories and [installation](../START_HERE.md) for setup.

## Product guides and contracts

| Surface | Current role | Read |
| --- | --- | --- |
| Studio | Image/video generation, revisions, presets and local media library | [Overview](../README.md), [controls](keyboard-mouse-controls.md) |
| Graph Studio — experimental | Backend-defined visual workflows for image, video, audio and prompt processing | [Design contract](graph-studio-design.md), [node library](graph-studio-node-library.md), [node authoring](graph-studio-node-authoring.md) |
| Media Assistant — experimental | Graph workspace assistance, reusable artifact drafting, reviewed edits and separate execution approval | [Behavior](media-assistant.md), [setup](media-assistant-setup.md), [runtime contract](assistant-runtime-contract.md), [Claude improvement plan](assistant-claude-improvement-plan.md), [continuations](media-assistant-continuations.md), [result reuse](media-assistant-result-reuse.md) |
| Media Presets | Reusable generation templates, fields and media inputs | [Preset system](media-studio-preset-system.md) |
| Prompt Recipes | Reusable LLM instructions and inputs, distinct from Media Presets | [Overview](../README.md), [Graph node library](graph-studio-node-library.md) |

For current assistant recovery behavior, see [Graph outcomes](assistant-graph-outcomes.md), [draft and reference recovery](assistant-draft-recovery.md) and [enhancement recovery](prompt-enhancement-recovery.md).

Suno audio generation is available in Graph Studio. The main Studio composer remains an image/video surface. Custom executable node packs are a future architecture proposal, not a supported import format; see [extension architecture](graph-studio-node-extension-architecture.md).

## Setup and operations

[macOS](getting-started-mac.md) · [Windows](getting-started-windows.md) · [Linux](getting-started-linux.md) · [Prerequisites](prerequisites.md) · [Advanced runtime](advanced-runtime.md) · [Architecture overview](project-architecture-overview.md) · [Supervision](runtime-and-supervision.md) · [Pricing integration](pricing-integration.md) · [Release packaging](release-packaging.md)

## Release notes and historical evidence

[v1.0.5 notes](releases/v1.0.5.md) describe the package changes; a notes file does not establish that a release tag has been published. Check [GitHub releases](https://github.com/gateway/media-studio/releases) for published distributions.

The [September integration handoff](media-assistant-september-handoff.md) is historical. Dated acceptance logs in the Assistant guide preserve what was observed at that checkpoint, including unresolved limits; they should not be read as a new feature queue. Design proposals describe intent unless explicitly marked implemented. Current backend definitions and focused tests remain authoritative for executable node contracts.
