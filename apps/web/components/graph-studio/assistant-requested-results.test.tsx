// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantRequestedResult, AssistantResultAttachments, requestedResultBindings, useAssistantResults } from './assistant-results';

const binding = { run_id: 'original-run', artifact_id: 'original', version: 'v1' };
const original = { ...binding, node_title: 'Original storyboard', output_port: 'image', output_index: 0, media_type: 'image', available: true, url: '/original.png' };
const response = { run_id: 'current-run', status: 'completed', items: [{ ...original, run_id: 'current-run', artifact_id: 'nighttime', url: '/nighttime.png' }], selected_artifact_ids: [], selected_result_bindings: {} };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const onAsk = vi.fn(); const onPreview = vi.fn();
function Harness({ session = 'session', runId = 'current-run' as string | null, requested = [binding] }) {
  const results = useAssistantResults({ sessionId: session, runId, workspaceKey: session, enabled: true, requestedResults: requested });
  return <AssistantRequestedResult binding={binding} results={results} disabled={false} onAsk={onAsk} onOpenPreview={onPreview} />;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('displays the exact historical image and selects it only on explicit action', async () => {
  let selected = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { expect(JSON.parse(String(init.body))).toEqual({ ...binding, selected: true }); selected = true; }
    return reply({ ...response, run_id: url.includes('original-run') ? 'original-run' : response.run_id, items: url.includes('original-run') ? [original] : response.items,
      selected_artifact_ids: selected ? ['original'] : [], selected_result_bindings: selected ? { original: binding } : {} });
  });
  vi.stubGlobal('fetch', fetcher); render(<Harness />);
  const preview = await screen.findByRole('button', { name: 'Open Original storyboard result 1 preview' });
  expect(screen.getByRole('img').getAttribute('src')).toBe('/original.png');
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(preview); expect(onPreview).toHaveBeenCalledWith({ mediaType: 'image', url: '/original.png', label: 'Original storyboard result 1' });
  fireEvent.click(screen.getByRole('button', { name: 'Use in chat — Original storyboard' }));
  expect(await screen.findByRole('button', { name: 'In this conversation — Original storyboard' })).toBeTruthy();
  expect(onAsk).toHaveBeenCalledOnce();
});

it.each(['stale', 'missing', 'unavailable', 'foreign'])('never displays substituted or broken media when %s', async (condition) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!url.includes('original-run')) return reply(response);
    if (condition === 'foreign') return new Response(JSON.stringify({ detail: 'This run does not belong to this conversation.' }), { status: 409 });
    return reply({ ...response, items: condition === 'missing' ? [] : [{ ...original, version: condition === 'stale' ? 'v2' : 'v1', available: condition !== 'unavailable' }] });
  }));
  render(<Harness />); expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByRole('button', { name: /Use in chat/ })).toBeNull();
});

it('can show a historical result without a current canvas run', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ ...response, run_id: 'original-run', items: [original] })));
  render(<Harness runId={null} />); expect(await screen.findByRole('img')).toHaveProperty('src', 'http://localhost:3000/original.png');
});

it('does not expose a previous conversation while the next one is loading', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/other/') ? new Promise<Response>(() => {}) : Promise.resolve(reply({ ...response, items: [original] }))));
  const view = render(<Harness />); await screen.findByRole('img'); view.rerender(<Harness session="other" />);
  await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
});

it('accepts only typed display artifacts, not raw image Markdown or arbitrary URLs', () => {
  expect(requestedResultBindings({ kernel_turn: { artifacts: [{ kind: 'result_display', data: binding }] } })).toEqual([binding]);
  expect(requestedResultBindings({ kernel_turn: { artifacts: [{ kind: 'result_display', data: { url: 'https://example.test/a.png' } }] } })).toEqual([]);
  expect(requestedResultBindings({ reply: '![image](/image.png)' })).toEqual([]);
});

it('allows selecting the displayed version when an older version is attached', async () => {
  let selected = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { expect(JSON.parse(String(init.body))).toEqual({ ...binding, selected: true }); selected = true; }
    return reply({ ...response, run_id: url.includes('original-run') ? 'original-run' : response.run_id, items: url.includes('original-run') ? [original] : response.items,
      selected_artifact_ids: ['original'], selected_result_bindings: { original: { run_id: binding.run_id, version: selected ? binding.version : 'older' } } });
  }));
  render(<Harness />);
  const use = await screen.findByRole('button', { name: 'Use in chat — Original storyboard' });
  expect(use).toHaveProperty('disabled', false); fireEvent.click(use);
  expect(await screen.findByRole('button', { name: 'In this conversation — Original storyboard' })).toHaveProperty('disabled', true);
  expect(onAsk).toHaveBeenCalledOnce();
});

it.each(['current-run', null])('isolates an unavailable primary run (%s) from a valid requested image', async (runId) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('original-run')
    ? reply({ ...response, run_id: binding.run_id, items: [original] })
    : new Response(JSON.stringify({ detail: 'Run unavailable' }), { status: 404 })));
  render(<Harness runId={runId} requested={[{ ...binding, run_id: 'missing-run' }, binding]} />);
  expect(await screen.findByRole('img')).toHaveProperty('src', 'http://localhost:3000/original.png');
  expect(screen.getByRole('button', { name: 'Use in chat — Original storyboard' })).toHaveProperty('disabled', false);
});

it.each(['connection', 'server'])('keeps historical selection %s recovery visible without a current run and retries only on request', async (failure) => {
    let failed = true, selected = false;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            expect(JSON.parse(String(init.body))).toEqual({ ...binding, selected: true });
            if (failed) {
                if (failure === 'connection')
                    throw new TypeError('Failed to fetch');
                return new Response('Internal Server Error', { status: 500 });
            }
            selected = true;
        }
        return reply({ ...response, run_id: binding.run_id, items: [original], selected_artifact_ids: selected ? [binding.artifact_id] : [], selected_result_bindings: selected ? { original: binding } : {} });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<Harness runId={null}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Use in chat — Original storyboard' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Couldn’t confirm this media selection. Check the media in this conversation, then retry the selection. Nothing will regenerate.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry media selection' })).toHaveProperty('disabled', false));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(screen.getByText(failure === 'connection' ? 'Failed to fetch' : 'Request failed with 500').closest('details')).not.toBeNull();
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry media selection' }));
    expect(await screen.findByRole('button', { name: 'In this conversation — Original storyboard' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onAsk).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
});
it('reconciles a lost selection response that actually persisted without posting again', async () => {
    let persisted = false;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            persisted = true;
            throw new TypeError('Response lost');
        }
        return reply({ ...response, run_id: binding.run_id, items: [original],
            selected_artifact_ids: persisted ? ['original'] : [], selected_result_bindings: persisted ? { original: binding } : {} });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<Harness runId={null}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Use in chat — Original storyboard' }));
    expect(await screen.findByRole('button', { name: 'In this conversation — Original storyboard' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(onAsk).not.toHaveBeenCalled();
});
it('keeps a changed historical version unavailable after a rejected selection', async () => {
    let changed = false;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            changed = true;
            return new Response(JSON.stringify({ detail: 'This exact result changed.' }), { status: 409 });
        }
        return reply({ ...response, run_id: binding.run_id, items: [{ ...original, version: changed ? 'v2' : 'v1' }] });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<Harness runId={null}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Use in chat — Original storyboard' }));
    expect(await screen.findByText('This exact image is unavailable or changed. Ask to show it again or choose another result; nothing will regenerate.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry media selection' })).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('recovers an unconfirmed media removal without deleting the media file', async () => {
    let failed = true, selected = true;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            expect(JSON.parse(String(init.body))).toEqual({ ...binding, selected: false });
            if (failed)
                throw new TypeError('Removal response lost');
            selected = false;
        }
        return reply({ ...response, run_id: binding.run_id, items: [original],
            selected_artifact_ids: selected ? ['original'] : [], selected_result_bindings: selected ? { original: binding } : {} });
    });
    function Attachments() {
        const results = useAssistantResults({ sessionId: 'session', runId: null, workspaceKey: 'session', enabled: true, requestedResults: [binding] });
        return <AssistantResultAttachments results={results} disabled={false}/>;
    }
    vi.stubGlobal('fetch', fetcher);
    render(<Attachments />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from conversation: Original storyboard' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Couldn’t confirm that this media was removed from the conversation. Check the media in this conversation, then retry the removal. The media file will stay saved.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry removing media' })).toHaveProperty('disabled', false));
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry removing media' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Media in this conversation' })).toBeNull());
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});

it('preserves selection uncertainty through a failed results reload and verifies the exact version before retrying', async () => {
  let requested = false, readable = true, selected = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ ...binding, selected: true });
      if (!requested) { requested = true; readable = false; throw new TypeError('Selection response lost'); }
      selected = true;
    }
    if (!readable) throw new TypeError('Results connection lost');
    return reply({ ...response, run_id: binding.run_id, items: [original],
      selected_artifact_ids: selected ? ['original'] : [], selected_result_bindings: selected ? { original: binding } : {} });
  });
  vi.stubGlobal('fetch', fetcher); render(<Harness runId={null} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Use in chat — Original storyboard' }));
  expect(await screen.findByText('Couldn’t load this requested image. Check your connection and try loading it again. No new run will start.')).toBeTruthy();
  expect(screen.getByText('Couldn’t confirm this media selection. Check the media in this conversation, then retry the selection. Nothing will regenerate.')).toBeTruthy();
  expect(screen.getByText('Selection response lost').closest('details')).not.toBeNull();
  expect(screen.getByText('Results connection lost').closest('details')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Retry media selection' })).toHaveProperty('disabled', true);
  expect(screen.queryByText(/This exact image is unavailable or changed/)).toBeNull();
  readable = true; fireEvent.click(screen.getByRole('button', { name: 'Try loading requested image again' }));
  expect(await screen.findByRole('img')).toBeTruthy();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry media selection' })).toHaveProperty('disabled', false));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry media selection' }));
  expect(await screen.findByRole('button', { name: 'In this conversation — Original storyboard' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
});
