import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),usage:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/supabase/admin',()=>({supabaseAdmin:{rpc:m.rpc,from:m.from}}));
vi.mock('@/lib/billing/usage',()=>({recordOutboundSmsUsage:m.usage}));
import { finalizeBookingSummarySend, type BookingSummarySend } from './summarySend.server';
const accepted:BookingSummarySend={draft_id:'draft',business_id:'business',revision:1,content:'Review details?',status:'accepted',provider_message_id:'provider',accepted_at:'2026-09-17T12:00:00Z',usage_recorded_at:null};
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockResolvedValue({data:{id:'original'},error:null});m.from.mockImplementation(()=>{const q={update:()=>q,eq:()=>q,is:()=>q,then:(resolve:(r:unknown)=>unknown)=>Promise.resolve({error:null}).then(resolve)};return q;});});
it('reuses one stable usage identity during recovery',async()=>{
 await finalizeBookingSummarySend(accepted);await finalizeBookingSummarySend(accepted);
 expect(m.usage).toHaveBeenCalledTimes(2);
 for(const [args] of m.usage.mock.calls)expect(args).toMatchObject({providerMessageId:'provider',idempotencyKey:'booking-summary:draft'});
 expect(m.rpc).toHaveBeenCalledWith('finalize_booking_summary_send',{p_draft_id:'draft'});
});
it('never counts unconfirmed provider acceptance',async()=>{
 await expect(finalizeBookingSummarySend({...accepted,status:'uncertain',provider_message_id:null})).rejects.toThrow('acceptance_missing');
 expect(m.usage).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
});
it('recovers bookkeeping before marking the usage complete',async()=>{
 m.rpc.mockResolvedValue({data:null,error:{message:'unavailable'}});
 await expect(finalizeBookingSummarySend(accepted)).rejects.toThrow('bookkeeping_failed');
 expect(m.usage).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled();
});
