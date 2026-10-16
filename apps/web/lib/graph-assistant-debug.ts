"use client";

export function isGraphAssistantDebugEnabled() {
  return process.env.NEXT_PUBLIC_MEDIA_STUDIO_ASSISTANT_DEBUG === "1";
}

export function isGraphAssistantAvailable(
  health:
    | {
        codex_local_ready?: unknown;
        media_assistant_enabled?: unknown;
        media_assistant_runtime_ready?: unknown;
      }
    | null
    | undefined,
) {
  return (
    isGraphAssistantDebugEnabled() &&
    health?.media_assistant_enabled === true &&
    // The API reports readiness for whichever runtime the assistant will use
    // (Codex Local or an env-configured provider such as Merge Gateway).
    (typeof health.media_assistant_runtime_ready === "boolean"
      ? health.media_assistant_runtime_ready
      : health.codex_local_ready === true)
  );
}
