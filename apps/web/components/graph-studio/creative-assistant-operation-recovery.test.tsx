// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCreativeAssistant } from './hooks/use-creative-assistant';
import { CreativeAssistantPanel } from '@/components/graph-studio/creative-assistant-panel';
const workflow = { schema_version: 1, workflow_id: 'workflow-1', name: 'Review graph', nodes: [], edges: [], metadata: {} };
const base = { assistant_session_id: 'session-1', owner_kind: 'graph_workflow', owner_id: 'workflow-1', provider_kind: 'codex_local', status: 'active', attachments: [], messages: [] };
const idle = { active: false, stage: 'idle', label: '', elapsed_seconds: 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const health = { media_assistant_enabled: true, codex_local_ready: true, codex_local_command_available: true, codex_local_login_configured: true };
const panelProps = { open: true, workspaceKey: 'review-A', workflowId: 'workflow-1', workflowName: 'Review graph', workflow, initialAssistantSessionId: 'session-1', references: [], importImageFile: vi.fn(), onApplyWorkflow: vi.fn(), onClose: vi.fn() };
beforeEach(() => vi.stubGlobal('ResizeObserver', class {
    observe() { }
    disconnect() { }
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each(['transport', 'http500'])('explains unconfirmed Stop after a %s failure and allows explicit retry', async (kind) => {
    let sending = false, cancelAttempts = 0;
    const events = vi.fn();
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/messages')) {
            sending = true;
            return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        }
        if (url.endsWith('/cancel') && ++cancelAttempts === 2) {
            sending = false;
            return Promise.resolve(json(base));
        }
        if (url.endsWith('/cancel'))
            return kind === 'transport' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response('Internal Server Error', { status: 500 }));
        if (url.endsWith('/progress'))
            return Promise.resolve(json(sending ? { ...idle, active: true, stage: 'thinking', label: 'Thinking' } : idle));
        if (url.endsWith('/session-1'))
            return Promise.resolve(json(base));
        return Promise.resolve(json(health));
    });
    vi.stubGlobal('fetch', fetcher);
    render(<CreativeAssistantPanel {...panelProps} onEvent={events}/>);
    const send = await screen.findByRole('button', { name: 'Send chat message' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop assistant request' })).toBeNull());
    fireEvent.change(screen.getByRole('textbox', { name: 'Assistant message' }), { target: { value: 'Keep this request.' } });
    fireEvent.click(send);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop assistant request' }));
    const message = 'Couldn’t confirm that the assistant stopped. Check your connection and choose Stop again.';
    expect(await screen.findByText(message)).toBeTruthy();
    expect(events).toHaveBeenCalledWith(message, 'error');
    expect(screen.getByText(kind === 'transport' ? 'Failed to fetch' : 'Request failed with 500').closest('details')).not.toBeNull();
    expect(events).not.toHaveBeenCalledWith('Assistant stopped.', 'muted');
    expect(screen.getByRole('button', { name: 'Stop assistant request' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send chat message' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop assistant request' }));
    await waitFor(() => expect(events).toHaveBeenCalledWith('Assistant stopped.', 'muted'));
    expect(cancelAttempts).toBe(2);
});
it.each(['attach', 'remove', 'import', 'rejection'])('reports reference %s failures through the public operation and keeps diagnostics secondary', async (operation) => {
    const events = vi.fn();
    const fetcher = vi.fn((url: string) => {
        if (url.endsWith('/attachments') || url.endsWith('/attachments/attachment-1')) {
            return operation === 'rejection'
                ? Promise.resolve(json({ detail: 'This reference belongs to another conversation.' }, 409))
                : Promise.reject(new TypeError('Failed to fetch'));
        }
        return Promise.resolve(json(url.endsWith('/progress') ? idle : url.endsWith('/session-1') ? base : health));
    });
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useCreativeAssistant({
        ...panelProps, enabled: true, onEvent: events,
        importImageFile: async () => { throw new Error('Upload service unavailable'); },
    }));
    await waitFor(() => expect(result.current.session?.assistant_session_id).toBe('session-1'));
    await act(async () => {
        if (operation === 'remove')
            await result.current.removeAttachment('attachment-1');
        else if (operation === 'import')
            await result.current.attachFile(new File(['image'], 'amber.png', { type: 'image/png' }));
        else
            await result.current.attachReference({ reference_id: 'reference-1', original_filename: 'amber.png' } as Parameters<typeof result.current.attachReference>[0]);
    });
    const expected = operation === 'import'
        ? 'Couldn’t import this reference image. Check your connection and choose the file again.'
        : operation === 'rejection' ? 'This reference belongs to another conversation.'
            : `Couldn’t confirm that the reference image was ${operation === 'remove' ? 'removed' : 'attached'}. Check the attached images before trying again.`;
    expect(result.current.error).toBe(expected);
    expect(events).toHaveBeenCalledWith(expected, 'error');
    expect(result.current.errorDetails).toBe(operation === 'import' ? 'Upload service unavailable' : operation === 'rejection' ? expected : 'Failed to fetch');
    expect(result.current.busy).toBe(false);
});
