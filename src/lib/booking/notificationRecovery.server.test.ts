import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),retrieve:vi.fn(),usage:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/supabase/admin',()=>({supabaseAdmin:{from:m.from,rpc:m.rpc}}));
vi.mock('@/lib/messaging/client',()=>({telnyx:{messages:{retrieve:m.retrieve}}}));
vi.mock('@/lib/messaging/lookup',()=>({getOutboundSendContext:vi.fn()}));
vi.mock('@/lib/billing/usage',()=>({preflightOutboundSms:vi.fn(),recordOutboundSmsUsage:m.usage}));
vi.mock('@/lib/messaging/outboundSmsOperational.server',()=>({resolveOutboundSmsOperationalAccess:vi.fn()}));
import { reconcileBookingNotifications } from './notifications.server';
let actionFailure:boolean;let changes:Array<{table:string;patch:Record<string,unknown>}>;
beforeEach(()=>{
 vi.clearAllMocks();actionFailure=false;changes=[];
 m.rpc.mockResolvedValue({data:{id:'notice'},error:null});
 m.retrieve.mockResolvedValue({data:{from:{phone_number:'+15555550200'},to:[{phone_number:'+15555550100',status:'delivered'}]}});
 m.from.mockImplementation((table:string)=>{
  let patch:Record<string,unknown>|null=null;
  const q:Record<string,unknown>={};for(const method of ['select','eq','in','or','order','limit','single'])q[method]=()=>q;
  q.update=(p:Record<string,unknown>)=>{patch=p;return q;};
  q.then=(resolve:(v:unknown)=>unknown)=>Promise.resolve().then(()=>{
   if(patch){changes.push({table,patch});return{data:[],error:table==='voice_actions'&&actionFailure?{message:'temporary failure'}:null};}
   return{error:null,data:table==='voice_actions'?{session_id:'call'}:table==='voice_sessions'?{called_phone:'+15555550200'}:[{id:'notice',business_id:'business',draft_id:'draft',permission_action_id:'permission',destination:'+15555550100',content:'details',status:'accepted',provider_message_id:'provider',accepted_at:'2026-09-17T12:00:00Z',usage_recorded_at:'2026-09-17T12:00:00Z',action_recorded_at:null}]};
  }).then(resolve);return q;
 });
});
it('recovers action outcome before marking notification recovery complete',async()=>{
 await reconcileBookingNotifications();
 const actionIndex=changes.findIndex(c=>c.table==='voice_actions');
 const completionIndex=changes.findIndex(c=>c.table==='booking_notifications'&&c.patch.action_recorded_at);
 expect(actionIndex).toBeGreaterThanOrEqual(0);expect(completionIndex).toBeGreaterThan(actionIndex);
 expect(changes[completionIndex].patch.status).toBe('delivered');expect(m.usage).not.toHaveBeenCalled();
});
it('leaves action recovery pending when the action record cannot be saved',async()=>{
 actionFailure=true;
 await expect(reconcileBookingNotifications()).rejects.toThrow('action_recovery_failed');
 expect(changes.some(c=>c.patch.action_recorded_at)).toBe(false);
 actionFailure=false;await reconcileBookingNotifications();
 expect(changes.some(c=>c.patch.action_recorded_at)).toBe(true);
});
it('rejects a provider result from another sending number',async()=>{
 m.retrieve.mockResolvedValue({data:{from:{phone_number:'+15555550999'},to:[{phone_number:'+15555550100',status:'delivered'}]}});
 await expect(reconcileBookingNotifications()).rejects.toThrow('provider_mismatch');
 expect(changes.some(c=>c.table==='voice_actions')).toBe(false);
});
