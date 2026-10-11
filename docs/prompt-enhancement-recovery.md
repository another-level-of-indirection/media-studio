# Recovering from prompt enhancement failures

Enhance previews a rewritten prompt. **Use Prompt** applies a successful preview to the composer. Neither action submits media generation.

When a connection fails, check the connection and try Enhance again. For a timeout, check the enhancement provider in Settings and retry. Setup messages still identify missing instructions or provider configuration. Instructions for a selected Studio model live under **Models → System Prompt**; the default enhancement provider and model live under **Settings → AI**.

The enhancement dialog and Studio activity use the same failure guidance. The original prompt and attached references remain in the composer through failure and retry. A previous preview clears when a new request starts, and **Use Prompt** remains unavailable during that request or after failure.

Known provider and internal route diagnostics use recovery guidance in the primary message. Their original response remains inspectable through the browser’s Network tools; the existing opt-in **Settings → General → Studio Debug Console** also records enhancement response status and errors. Helpful provider setup advice remains visible.
