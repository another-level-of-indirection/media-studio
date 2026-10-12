// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCreativeAssistant } from '@/components/graph-studio/hooks/use-creative-assistant';
import { CreativeAssistantPanel } from '@/components/graph-studio/creative-assistant-panel';
import { assistantTestWorkflow as workflow, assistantTestSession as session, assistantIdleProgress as idle } from '@/components/graph-studio/creative-assistant-test-fixtures';
const json=(body:unknown,status=200)=>Promise.resolve(Response.json(body,{status}));
const base={...session,messages:[]};
const props={workspaceKey:'A',workflowId:'workflow-1',workflowName:'Graph',workflow,enabled:true,initialAssistantSessionId:'session-1',importImageFile:vi.fn(),onApplyWorkflow:vi.fn()};
function deferred(){let resolve!:(r:Response)=>void;let reject!:(e:unknown)=>void;const promise=new Promise<Response>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
// Exercise real public hooks/components; only external fetch/import/run boundaries are simulated.
it.each(['attach success','attach error','remove error'])('ignores stale reference completion in B: %s',async(stage)=>{
 const late=deferred();const events=vi.fn();
 vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{
  if(init?.method==='POST'&&url.endsWith('/attachments')||init?.method==='DELETE')return late.promise;
  if(url.endsWith('/progress'))return json(idle);
  if(url.endsWith('/session-1'))return json(base);
  if(url.endsWith('/session-2'))return json({...base,assistant_session_id:'session-2',owner_id:'workflow-2'});
  return json({ready:true});
 }));
 const {result,rerender}=renderHook(p=>useCreativeAssistant(p),{initialProps:{...props,onEvent:events}});
 await waitFor(()=>expect(result.current.busy).toBe(false));
 await waitFor(()=>expect(result.current.session?.assistant_session_id).toBe('session-1'));
 let pending:Promise<unknown>;
 act(()=>{pending=stage==='remove error'?result.current.removeAttachment('attachment-A'):result.current.attachReference({reference_id:'reference-A',kind:'image',original_filename:'A.png'} as Parameters<typeof result.current.attachReference>[0]);});
 await waitFor(()=>expect(result.current.status).toBe('uploading'));
 await act(async()=>{await Promise.resolve();});
 rerender({...props,onEvent:events,workspaceKey:'B',workflowId:'workflow-2',initialAssistantSessionId:'session-2'});
 await waitFor(()=>expect(result.current.session?.assistant_session_id).toBe('session-2'));
 await act(async()=>{if(stage==='attach success')late.resolve(await json({assistant_attachment_id:'attachment-A',reference_id:'reference-A',kind:'reference_image'}));else late.reject(new TypeError('Failed to fetch'));await pending!;});
 expect(result.current.session?.assistant_session_id).toBe('session-2');
 expect(result.current.session?.attachments).toEqual([]);
 expect(result.current.error).toBeNull();expect(events).not.toHaveBeenCalled();
});
it('provides read-only saved-conversation retry with optional diagnostics',async()=>{
 let reads=0;vi.stubGlobal('fetch',vi.fn((url:string)=>url.endsWith('/session-1')?(++reads===1?Promise.reject(new TypeError('Failed to fetch')):json({...base,messages:[{assistant_message_id:'loaded',role:'assistant',content_text:'Saved conversation loaded.'}]})):json(url.endsWith('/progress')?idle:{ready:true})));
 render(<CreativeAssistantPanel {...props} open references={[]} onClose={vi.fn()}/>);
 const raw=await screen.findByText('Failed to fetch');
 expect(raw.closest('details')).not.toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Reload saved conversation'}));
 await screen.findByText('Saved conversation loaded.');expect(reads).toBeGreaterThanOrEqual(2);
 expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
});
it('retries failed reference listing without false empty claims',async()=>{
 let reads=0;const events=vi.fn();
 vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('/reference-media')?(++reads===1?Promise.reject(new TypeError('Failed to fetch')):json({items:[],next_offset:null})):json(url.endsWith('/progress')?idle:url.endsWith('/session-1')?{...base,messages:[{assistant_message_id:'loaded',role:'assistant',content_text:'Saved conversation loaded.'}]}:{ready:true})));
 render(<CreativeAssistantPanel {...props} open references={[]} onClose={vi.fn()} onEvent={events}/>);
 await screen.findByText('Saved conversation loaded.');
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Stop assistant request'})).toBeNull());
 const button=screen.getAllByRole('button').find(b=>/choose.*reference/i.test(b.getAttribute('aria-label')??b.textContent??''));
 expect(button).toBeTruthy();fireEvent.click(button!);
 const dialog=await screen.findByRole('dialog',{name:'Reference image picker'});
 await within(dialog).findByText('Couldn’t load reference images. Retry loading the image list.');
 expect(within(dialog).queryByText('No reference images are available yet.')).toBeNull();
 expect(within(dialog).getByText('Failed to fetch').closest('details')).not.toBeNull();
 fireEvent.click(within(dialog).getByRole('button',{name:'Retry loading images'}));
 await within(dialog).findByText('No reference images are available yet.');expect(reads).toBe(2);
});
const plan={plan:{assistant_plan_id:'plan-1',assistant_session_id:'session-1',status:'validated',capability:'plan_graph'},graph_plan:{capability:'plan_graph',summary:'Prepared graph',questions:[],operations:[{op:'add_node'}],warnings:[],requires_confirmation:true,metadata:{kernel_proposal:true}},workflow:{...workflow,nodes:[{id:'prompt',type:'prompt.text',position:{x:0,y:0},fields:{text:'Create an image'}}]},validation:{valid:true,errors:[],warnings:[]},pricing:{pricing_summary:{total:{estimated_credits:0,estimated_cost_usd:0}},nodes:{},warnings:[]}};
const message={assistant_message_id:'confirm',role:'assistant',content_text:'Graph prepared.',content_json:{mode:'assistant_kernel',next_action:{kind:'confirm_graph',label:'Add to canvas',proposal_id:'plan-1',confirmation_token:'exact-token',requires_confirmation:true,payload:{proposal_id:'plan-1',confirmation_token:'exact-token'}}}};
it.each(['lost response','delivery error'])('recovers exact approved graph without a duplicate approval: %s',async(stage)=>{
 let committed=false;const apply=vi.fn().mockRejectedValueOnce(new Error('Canvas delivery failed')).mockResolvedValue(undefined);const fetcher=vi.fn((url:string)=>{
  if(url.endsWith('/apply')){committed=true;return stage==='lost response'?Promise.reject(new TypeError('Failed to fetch')):json({...plan,plan:{...plan.plan,status:'applied'}});}
  return json(url.endsWith('/progress')?idle:url.endsWith('/session-1')?{...base,messages:[message],latest_plan:committed?{...plan,plan:{...plan.plan,status:'applied'}}:plan}:{ready:true});
 });vi.stubGlobal('fetch',fetcher);
 const {result}=renderHook(()=>useCreativeAssistant({...props,onApplyWorkflow:apply}));
 await waitFor(()=>expect(result.current.canApply).toBe(true));
 await act(async()=>{await result.current.applyPlan();});
 expect(result.current.failedApplyPlanId).toBe('plan-1');expect(result.current.applyRecovery).not.toBeNull();
 expect(result.current.error).toMatch(stage==='lost response'?/couldn’t confirm whether.*approved/i:/approved.*couldn’t be placed/i);
 expect(result.current.deliveredPlanId).toBeNull();
 act(()=>result.current.setDraft('Keep this next request.'));
 await act(async()=>{await result.current.sendContentMessage('Prepare a different graph.');await result.current.createPlanFromContent('Another proposal.');});
 expect(result.current.plan?.plan.assistant_plan_id).toBe('plan-1');expect(result.current.draft).toBe('Keep this next request.');
 expect(fetcher.mock.calls.some(([url])=>url.endsWith('/messages')||url.endsWith('/plans'))).toBe(false);
 expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/apply'))).toHaveLength(1);
 if(stage==='lost response'){await act(async()=>{await result.current.recoverGraphApply();});expect(apply).not.toHaveBeenCalled();}
 await act(async()=>{await result.current.recoverGraphApply();});
 if(stage==='lost response')await act(async()=>{await result.current.recoverGraphApply();});
 expect(result.current.deliveredPlanId).toBe('plan-1');expect(result.current.applyRecovery).toBeNull();
 expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/apply'))).toHaveLength(1);
 expect(apply).toHaveBeenLastCalledWith(plan.workflow,expect.any(Object));
});
it('retries saved recipe availability without saving twice',async()=>{
 const savedMessage={assistant_message_id:'save',role:'assistant',content_text:'Recipe prepared.',content_json:{mode:'assistant_kernel',next_action:{kind:'save_prompt_recipe',label:'Save draft',proposal_id:'exact-proposal',confirmation_token:'exact-token',requires_confirmation:true,payload:{proposal_id:'exact-proposal',confirmation_token:'exact-token',save_mode:'verified',quality_state:'quality_verified'}}}};
 vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>undefined});
 let refreshes=0,saves=0;const events=vi.fn();vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url.endsWith('/node-definitions/refresh'))return ++refreshes===1?Promise.resolve(new Response('Internal Server Error',{status:500})):json({});
  if(url.endsWith('/recipe-saves')){saves++;return json({message:'Prompt Recipe saved.',assistant_session:{...base,messages:[savedMessage],summary_json:{kernel_recipe_proposal:{proposal_id:'exact-proposal',consumed:true}}}});}
  return json(url.endsWith('/progress')?idle:url.endsWith('/session-1')?{...base,messages:[savedMessage],summary_json:{kernel_recipe_proposal:{proposal_id:'exact-proposal',consumed:false}}}:{ready:true});
 }));
 const {result}=renderHook(()=>useCreativeAssistant({...props,onEvent:events}));
 await waitFor(()=>expect(result.current.busy).toBe(false));await waitFor(()=>expect(result.current.session?.messages).toHaveLength(1));
 await act(async()=>{await result.current.confirmRecipeSave();});
 expect(events).toHaveBeenCalledWith(expect.stringMatching(/Prompt Recipe is saved.*graph availability/i),'warning');
 expect(result.current.artifactRefreshFailure?.detail).toBe('Unable to refresh graph node definitions.');
 await act(async()=>{await result.current.retryArtifactRefresh();});expect(refreshes).toBe(2);expect(saves).toBe(1);expect(result.current.artifactRefreshFailure).toBeNull();
 expect(events).toHaveBeenCalledWith('Prompt Recipe saved.','success');
 expect(result.current.session?.summary_json?.kernel_recipe_proposal).toMatchObject({consumed:true});
});
it.each(['connection','server'])('explains pre-submit run failure with optional diagnostics: %s',async(failure)=>{
 const raw=failure==='connection'?'Failed to fetch':'Request failed with 500';
 const run=vi.fn().mockRejectedValue(new Error(raw));
 const events=vi.fn();const runSession={...base,messages:[{assistant_message_id:'run',role:'assistant',content_text:'Graph ready.',content_json:{mode:'assistant_kernel',next_action:{kind:'run_workflow',label:'Review and run',confirmation_token:'run-token',requires_confirmation:true,payload:{confirmation_token:'run-token'},price_estimate:{pricing_summary:{total:{estimated_credits:0,estimated_cost_usd:0}}}}}}]};
 vi.stubGlobal('fetch',vi.fn((url:string)=>json(url.endsWith('/progress')?idle:url.endsWith('/session-1')?runSession:{ready:true})));
 const {result}=renderHook(()=>useCreativeAssistant({...props,onRunWorkflow:run,onEvent:events}));
 await waitFor(()=>expect(result.current.nextAction?.kind).toBe('run_workflow'));await waitFor(()=>expect(result.current.busy).toBe(false));
 await act(async()=>{await result.current.confirmRunWorkflow();});
 expect(run).toHaveBeenCalledTimes(1);expect(result.current.error).toMatch(/No run was submitted/);expect(result.current.errorDetails).toBe(raw);
 expect(events).toHaveBeenCalledWith(expect.stringMatching(/No run was submitted/),'error');expect(result.current.runSubmissionUncertain).toBe(false);expect(result.current.runConfirmationNeedsRecheck).toBe(false);
});
it('keeps Stop and monitoring after retrying an active saved conversation',async()=>{
 let reads=0;
 vi.stubGlobal('fetch',vi.fn((url:string)=>url.endsWith('/session-1')?(++reads===1?Promise.reject(new TypeError('Failed to fetch')):json({...base,messages:[{assistant_message_id:'waiting',role:'user',content_text:'Still thinking.'}]})):json(url.endsWith('/progress')?{...idle,active:true,stage:'thinking',label:'Working'}:{ready:true})));
 const {result}=renderHook(()=>useCreativeAssistant(props));
 await waitFor(()=>expect(result.current.sessionLoadFailed).toBe(true));
 await act(async()=>{await result.current.reloadConversation();});
 await waitFor(()=>expect(result.current.progress?.active).toBe(true));
 expect(result.current.busy).toBe(true);expect(result.current.cancellable).toBe(true);
});
it('does not install a late new session after leaving and returning to its workspace',async()=>{
 const late=deferred();let creates=0;
 const fetcher=vi.fn((url:string,init?:RequestInit)=>{
  if(url.endsWith('/sessions')&&init?.method==='POST'){creates++;return late.promise;}
  if(url.includes('/sessions?'))return json({items:[]});
  return json(url.endsWith('/progress')?idle:{ready:true});
 });vi.stubGlobal('fetch',fetcher);
 const emptyProps={...props,initialAssistantSessionId:null};
 const {result,rerender}=renderHook(p=>useCreativeAssistant(p),{initialProps:emptyProps});
 await waitFor(()=>expect(result.current.busy).toBe(false));
 let operation:Promise<unknown>;
 act(()=>{operation=result.current.attachReference({reference_id:'old-reference',kind:'image'} as Parameters<typeof result.current.attachReference>[0]);});
 await waitFor(()=>expect(creates).toBe(1));
 rerender({...emptyProps,workspaceKey:'B',workflowId:'workflow-2'});
 rerender(emptyProps);
 await act(async()=>{late.resolve(await json({...base,assistant_session_id:'late-session'}));await operation!;});
 expect(result.current.session).toBeNull();
 expect(fetcher.mock.calls.some(([url])=>url.endsWith('/attachments'))).toBe(false);
});
it.each(['import success','import failure'])('ignores stale file %s after changing sessions in one workspace',async(stage)=>{
 let resolve!:(r:unknown)=>void,reject!:(e:unknown)=>void;
 const imported=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const event=vi.fn(),onImported=vi.fn();
 const fetcher=vi.fn((url:string)=>json(url.endsWith('/progress')?idle:url.endsWith('/session-1')?base:url.endsWith('/session-2')?{...base,assistant_session_id:'session-2'}:{ready:true}));vi.stubGlobal('fetch',fetcher);
 const ownedProps={...props,importImageFile:vi.fn(()=>imported) as typeof props.importImageFile,onEvent:event};
 const {result,rerender}=renderHook(p=>useCreativeAssistant(p),{initialProps:ownedProps});
 await waitFor(()=>expect(result.current.busy).toBe(false));await waitFor(()=>expect(result.current.session?.assistant_session_id).toBe('session-1'));
 let operation:Promise<unknown>;act(()=>{operation=result.current.attachFile(new File(['x'],'test.png',{type:'image/png'}),onImported);});
 rerender({...ownedProps,initialAssistantSessionId:'session-2'});
 await waitFor(()=>expect(result.current.session?.assistant_session_id).toBe('session-2'));
 await act(async()=>{if(stage==='import success')resolve({reference_id:'old-file'});else reject(new Error('Old import failed'));await operation!;});
 expect(onImported).not.toHaveBeenCalled();expect(event).not.toHaveBeenCalled();expect(result.current.error).toBeNull();
 expect(fetcher.mock.calls.some(([url])=>url.endsWith('/attachments'))).toBe(false);
});
it('keeps a failed session read idle across parent event-handler rerenders',async()=>{
 let reads=0;
 vi.stubGlobal('fetch',vi.fn((url:string)=>url.endsWith('/session-1')?(reads++,Promise.reject(new TypeError('Offline'))):json({ready:true})));
 const {result,rerender}=renderHook(p=>useCreativeAssistant(p),{initialProps:{...props,onEvent:vi.fn()}});
 await waitFor(()=>expect(result.current.sessionLoadFailed).toBe(true));
 rerender({...props,onEvent:vi.fn()});
 await act(async()=>{await Promise.resolve();});
 expect(reads).toBe(1);expect(result.current.busy).toBe(false);
});
