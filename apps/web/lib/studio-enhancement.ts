import type { MediaEnhancementConfig } from "@/lib/types";

export function hasSavedEnhancementSystemPrompt(
  modelConfig: Pick<MediaEnhancementConfig, "system_prompt"> | null | undefined,
  globalConfig: Pick<MediaEnhancementConfig, "system_prompt"> | null | undefined,
) {
  const modelPrompt = (modelConfig?.system_prompt ?? "").trim();
  const globalPrompt = (globalConfig?.system_prompt ?? "").trim();
  return Boolean(modelPrompt || globalPrompt);
}

// Normalize known transport/provider diagnostics; keep actionable setup and validation guidance.
export function enhancementFailureMessage(message?: string) {
  if (!message || message.startsWith("Control API returned ") ||
      /^(openrouter|local_openai_compatible|codex_local) enhancement failed with \d+\./.test(message) ||
      ["Enhancement provider returned no choices.", "Enhancement provider returned an empty response.",
        "Enhancement provider returned an empty enhanced prompt."].includes(message)) {
    return "Couldn’t enhance your prompt. Try again, or check the enhancement provider in Settings.";
  }
  if (message === "The Control API is unavailable right now.") {
    return "Couldn’t enhance your prompt. Check your connection and try again.";
  }
  return message;
}
