// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreativeAssistantPanel } from "./creative-assistant-panel";
import { assistantIdleProgress, assistantSessionResponse, assistantJsonResponse as jsonResponse,
  assistantTestSession as session, assistantTestWorkflow as workflow } from "./creative-assistant-test-fixtures";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ["Media Preset", "save_media_preset", "preset-saves", "kernel_preset_proposal", "preset list"],
  ["Prompt Recipe", "save_prompt_recipe", "recipe-saves", "kernel_recipe_proposal", "recipe list"],
])("keeps %s confirmation after a connection failure and retries the same approved draft", async (label, kind, endpoint, proposalKey, list) => {
  const message = { assistant_message_id: "review", assistant_session_id: "session-1", role: "assistant", content_text: `${label} draft prepared for review. This draft has not been saved.`,
    content_json: { mode: "assistant_kernel", next_action: { kind, label: "Save draft", proposal_id: "exact-proposal", confirmation_token: "exact-token", requires_confirmation: true,
      payload: { proposal_id: "exact-proposal", confirmation_token: "exact-token", save_mode: "verified", quality_state: "quality_verified" } } } };
  let attempted = false;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith("/progress")) return jsonResponse(assistantIdleProgress);
    if (url.includes("/media/assistant/sessions?")) return jsonResponse({items:[]});
    if (url.endsWith("/media/assistant/sessions")) return jsonResponse({...session, messages:[]});
    if (url.endsWith("/messages")) return jsonResponse({...session, messages:[message], summary_json:{[proposalKey]:{proposal_id:"exact-proposal",consumed:false}}});
    if (url.endsWith(`/${endpoint}`)) {
      if (!attempted) { attempted = true; return Promise.reject(new TypeError("Failed to fetch")); }
      return jsonResponse({message:`${label} saved.`, assistant_session:{...session, messages:[message], summary_json:{[proposalKey]:{proposal_id:"exact-proposal",consumed:true}}}});
    }
    if (url.endsWith("/session-1")) return assistantSessionResponse(url, session);
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", {getItem:()=>null,setItem:()=>undefined});
  render(<CreativeAssistantPanel open workspaceKey="save-recovery" workflowId="workflow-1" workflowName="Review" workflow={workflow} references={[]}
    importImageFile={vi.fn()} onApplyWorkflow={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", {name:/assistant message/i}), {target:{value:`Save this ${label}.`}});
  await act(async()=>Promise.resolve());
  fireEvent.click(screen.getByRole("button",{name:/send chat message/i}));
  const buttonName = `Save confirmed ${label}`;
  fireEvent.click(await screen.findByRole("button",{name:buttonName}));
  expect(await screen.findByText(`Couldn’t confirm whether your ${label} was saved. Check the ${list} before trying again.`)).toBeTruthy();
  expect(screen.queryByText(`${label} saved.`)).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:buttonName}));
  await waitFor(()=>expect(screen.queryByRole("button",{name:buttonName})).toBeNull());
  const saves = fetchMock.mock.calls.filter(([url])=>url.endsWith(`/${endpoint}`));
  expect(saves).toHaveLength(2);
  for (const call of saves) expect(JSON.parse(String((call as unknown as [string,RequestInit])[1].body))).toMatchObject({proposal_id:"exact-proposal",confirmation_token:"exact-token"});
});
