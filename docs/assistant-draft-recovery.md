# Reviewing assistant drafts and recovering from errors

Media Presets and Prompt Recipes have separate review and save flows. A prepared draft is unsaved. Review its fields and warnings before saving; advanced inputs, template variables and output contracts remain available in the editors.

A Media Preset test graph can be reviewed and added to the canvas without starting a run. Saving a verified preset requires output review. The separate unverified draft option explains the missing output proof and requires acceptance before its save confirmation.

A validated Prompt Recipe can be saved after its confirmation. Saving stores the recipe; it does not execute the recipe or generate media.

If a save response is lost, check the corresponding preset or recipe list before retrying. The resource may have been saved even though the browser could not confirm it. Your draft fields remain available. If saving succeeded but the Graph node list could not refresh, the editor says the resource was saved and asks you to reload.

If an assistant draft cannot load because the connection failed, check the connection and reload its review page. If the draft is actually missing, ask the assistant to prepare it again. Recipe drafting failures preserve the idea and existing fields for retry. Known provider format failures show recovery guidance, with the original diagnostic available under **Draft failure details**.
