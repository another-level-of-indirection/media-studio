type ProviderRequestFailureKind = "connection" | "request";

export function isCodexLocalResponseFailure(message: string | undefined) {
  return message === "Codex Local App Server returned invalid JSON." || message === "Codex Local returned an empty response.";
}

// Enhancement narrows provider failures to its operation; recipe drafting accepts any operation.
export function providerRequestFailureKind(message: string | undefined, operation?: string): ProviderRequestFailureKind | null {
  if (message === "The Control API is unavailable right now.") return "connection";
  if (isCodexLocalResponseFailure(message)) return "request";
  if (!message || message.startsWith("Control API returned ")) return "request";
  const failure = /^(?:openrouter|local_openai_compatible|codex_local) (.*?) failed with \d+\./.exec(message);
  return failure && (operation === undefined || failure[1] === operation) ? "request" : null;
}
