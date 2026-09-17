import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),send:vi.fn(),optouts:vi.fn(),route:vi.fn(),usage:vi.fn(),record:vi.fn(),operational:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/supabase/admin',()=>({supabaseAdmin:{from:m.from,rpc:m.rpc}}));
vi.mock('@/lib/messaging/client',()=>({telnyx:{messages:{send:m.send},messagingOptouts:{list:m.optouts}}}));
vi.mock('@/lib/messaging/lookup',()=>({getOutboundSendContext:m.route}));
vi.mock('@/lib/billing/usage',()=>({preflightOutboundSms:m.usage,recordOutboundSmsUsage:m.record}));
vi.mock('@/lib/messaging/outboundSmsOperational.server',()=>({resolveOutboundSmsOperationalAccess:m.operational}));
import { sendBookingNotification, bookingNotificationBody } from './notifications.server';
import type { VoiceAction } from '@/lib/voice/actions';
import type { BookingSnapshot } from './contracts';
const snapshot:BookingSnapshot={offering:{serviceId:'service',serviceName:'Estimate',settingsRevision:1,format:'phone_callback',label:'Callback',durationMinutes:30,businessAddress:null,requiresCustomerAddress:false},name:'Sam',phone:'+15555550100',email:null,emailAsked:true,customerAddress:null,startTime:'2026-09-23T10:00:00',requestedTime:null,timezone:'America/Indiana/Indianapolis',mode:'schedule_direct'};
const action={id:'permission',business_id:'business',payload:{kind:'booking_confirmation_text',draftId:'draft',revision:1}} as VoiceAction;
const call={caller_phone:'+15555550100',called_phone:'+15555550200',conversation_id:'conversation'};
let notification:Record<string,unknown>; let patches:Record<string,unknown>[]; let claimed:boolean;
beforeEach(()=>{
 vi.clearAllMocks();claimed=false;patches=[];
 notification={id:'notice',business_id:'business',draft_id:'draft',draft_revision:1,purpose:'confirmation',permission_action_id:'permission',destination:call.caller_phone,content:'Confirmed details',status:'authorized',provider_message_id:null,accepted_at:null,usage_recorded_at:null};
 m.rpc.mockImplementation(async(name:string)=>({data:name==='authorize_booking_notification'?{...notification}:name==='finalize_booking_notification'?{id:'notice'}:true,error:null}));
 m.from.mockImplementation((table:string)=>{
  let patch:Record<string,unknown>|null=null;
  const q:Record<string,unknown>={};
  for(const method of ['select','eq','is','order','limit','maybeSingle'])q[method]=()=>q;
  q.update=(p:Record<string,unknown>)=>{patch=p;return q;};
  q.then=(resolve:(v:unknown)=>unknown)=>Promise.resolve().then(()=>{
   if(table==='booking_drafts')return {data:{id:'draft',revision:1,status:'confirmed',snapshot},error:null};
   if(patch){patches.push(patch);if(patch.status==='submitting'){if(claimed)return {data:[],error:null};claimed=true;}Object.assign(notification,patch);}
   return {data:[{id:'notice'}],error:null};
  }).then(resolve);return q;
 });
 m.route.mockResolvedValue({businessId:'business',smsReady:true,messagingProfileId:'profile'});
 m.optouts.mockImplementation(async function*(){});
 m.usage.mockResolvedValue({allowed:true});m.operational.mockResolvedValue({allowed:true});m.send.mockResolvedValue({data:{id:'provider'}});m.record.mockResolvedValue(undefined);
});
describe('booking text provider boundary',()=>{
 it('sends only after permission and persists provider acceptance before bookkeeping',async()=>{
  const result=await sendBookingNotification(action,call,'Business');
  expect(result.deliveryStatus).toBe('accepted');expect(m.send).toHaveBeenCalledTimes(1);
  expect(m.send).toHaveBeenCalledWith(expect.objectContaining({to:call.caller_phone}),{maxRetries:0,timeout:10000});
  expect(patches.find(p=>p.status==='accepted')).toMatchObject({provider_message_id:'provider'});
  expect(m.record).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:'booking-notification:notice'}));
 });
 it('does not resend an accepted or uncertain notification',async()=>{
  for(const status of ['accepted','uncertain']){notification.status=status;await sendBookingNotification(action,call,'Business');}
  expect(m.send).not.toHaveBeenCalled();
 });
 it('allows only one concurrent submission',async()=>{
  await Promise.all([sendBookingNotification(action,call,'Business'),sendBookingNotification(action,call,'Business')]);
  expect(m.send).toHaveBeenCalledTimes(1);
 });
 it('never retries unknown provider acceptance or charges unconfirmed usage',async()=>{
  m.send.mockRejectedValue(new Error('timeout'));
  expect((await sendBookingNotification(action,call,'Business')).deliveryStatus).toBe('uncertain');
  await sendBookingNotification(action,call,'Business');expect(m.send).toHaveBeenCalledTimes(1);expect(m.record).not.toHaveBeenCalled();
 });
 it('blocks opted-out destinations and wrong business routing',async()=>{
  m.optouts.mockImplementation(async function*(){yield{to:call.caller_phone};});
  expect((await sendBookingNotification(action,call,'Business')).deliveryStatus).toBe('failed');
  expect(m.send).not.toHaveBeenCalled();
 });
 it('keeps accepted texts accepted if bookkeeping is unavailable',async()=>{
  m.record.mockRejectedValue(new Error('database'));
  expect((await sendBookingNotification(action,call,'Business')).deliveryStatus).toBe('accepted');
  await sendBookingNotification(action,call,'Business');expect(m.send).toHaveBeenCalledTimes(1);
 });
 it('labels requests and review texts without claiming a booking',()=>{
  expect(bookingNotificationBody('Business',{...snapshot,mode:'collect_info'},'confirmation')).toContain('not a confirmed appointment');
  expect(bookingNotificationBody('Business',snapshot,'review')).toContain('Nothing is booked yet');
 });
});
