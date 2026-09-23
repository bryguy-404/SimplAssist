import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextingUpgradeRecord } from "@/lib/billing/textingUpgrade";
import type { SmsBillingOperation } from "./smsBilling.server";
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), retrieve: vi.fn(), update: vi.fn(), invoice: vi.fn(), list: vi.fn(), lines: vi.fn(), void: vi.fn(), preview: vi.fn(), price: vi.fn(), ready: vi.fn(), context: vi.fn(), getUpgrade: vi.fn(), rollout: vi.fn(), available: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: m.from, rpc: m.rpc } }));
vi.mock("./client", () => ({ stripe: { subscriptions: { retrieve: m.retrieve, update: m.update }, prices: { retrieve: m.price }, invoices: { retrieve: m.invoice, list: m.list, listLineItems: m.lines, voidInvoice: m.void, createPreview: m.preview } } }));
vi.mock("@/lib/billing/textingUpgradeStore.server", () => ({ getTextingUpgrade: m.getUpgrade, textingUpgradeRpc: async (name: string, args: unknown) => { const r = await m.rpc(name,args); if(r.error) throw new Error(r.error.message); return r.data; } }));
vi.mock("@/lib/billing/textingUpgrade.server", async () => { const { view } = await import("./smsBilling.server"); return { loadTextingUpgradeContext: m.context, requireTextingUpgradeReady: m.ready, textingUpgradeQuote: (op: SmsBillingOperation) => ({ ...view(op), quoteFingerprint: op.source_fingerprint, setupFeeCents:2500 }) }; });
vi.mock("@/lib/billing/textingUpgradeRollout.server", () => ({ isTextingUpgradeEnabled: m.rollout }));
vi.mock("@/lib/billing/planAvailability", () => ({ isPlanAvailable: m.available }));
import { cancelTextingUpgrade, confirmTextingUpgrade, quoteTextingUpgrade, reconcileTextingUpgradePayment, recoverTextingUpgradePayment, synchronizeTextingUpgradeSubscription, verifyTextingUpgradeInvoice } from "./textingUpgrade.server";
import { smsSubscriptionFingerprint } from "./smsBilling.server";
const businessId="10000000-0000-4000-8000-000000000001", ownerId="20000000-0000-4000-8000-000000000002", upgradeId="30000000-0000-4000-8000-000000000003", opId="40000000-0000-4000-8000-000000000004";
const now=Date.parse("2026-09-23T13:00:00Z")/1000, start=now-15*86400, end=now+15*86400;
const iso=(t:number)=>new Date(t*1000).toISOString();
let u:TextingUpgradeRecord, op:SmsBillingOperation, sub:Stripe.Subscription, inv:Stripe.Invoice;
function price(plan:string){return {id:`price_${plan}`,active:true,type:plan==='setup'?'one_time':'recurring',currency:'usd',unit_amount:plan==='chat_only'?1000:plan==='full'?6500:plan==='sms_and_chat'?4500:2500,recurring:plan==='setup'?null:{interval:'month',interval_count:1,usage_type:'licensed'}} as Stripe.Price;}
function lines():Stripe.InvoiceLineItem[]{return [
 {id:'il_fee',amount:2500,quantity:1,pricing:{price_details:{price:'price_setup'}},metadata:{chat_texting_upgrade_id:upgradeId,sms_billing_operation_id:opId},parent:{invoice_item_details:{invoice_item:'ii_fee'}}},
 {id:'il_target',amount:2750,quantity:1,pricing:{price_details:{price:op.target_price_id}},metadata:{},period:{start:now,end},parent:{subscription_item_details:{proration:true,subscription_item:'si_original'}}},
] as unknown as Stripe.InvoiceLineItem[];}
function context(){return {upgrade:u, operation:op, eligible:true};}
beforeEach(()=>{
 vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(now*1000);
 vi.stubEnv('STRIPE_SECRET_KEY','sk_test_fixture');vi.stubEnv('STRIPE_PRICE_CHAT_ONLY','price_chat_only');vi.stubEnv('STRIPE_PRICE_SMS_ONLY','price_sms_only');vi.stubEnv('STRIPE_PRICE_SMS_AND_CHAT','price_sms_and_chat');vi.stubEnv('STRIPE_PRICE_FULL','price_full');vi.stubEnv('STRIPE_PRICE_SETUP_FEE','price_setup');
 u={id:upgradeId,business_id:businessId,owner_id:ownerId,source_subscription_id:'sub_original',source_customer_id:'cus_original',target_plan:'full',state:'draft',billing_operation_id:opId,business_confirmed_at:iso(now),phone_confirmed_at:iso(now),starter_acknowledged_at:null,paid_at:null,activated_at:null,created_at:iso(now),updated_at:iso(now)};
 sub={id:'sub_original',customer:'cus_original',livemode:false,status:'active',cancel_at_period_end:false,schedule:null,pending_update:null,collection_method:'charge_automatically',discounts:[],metadata:{business_id:businessId,plan:'chat_only',checkout_attempt_id:'old-attempt'},latest_invoice:'in_original_chat',items:{has_more:false,data:[{id:'si_original',price:price('chat_only'),quantity:1,current_period_start:start,current_period_end:end}]}} as unknown as Stripe.Subscription;
 op={id:opId,business_id:businessId,owner_id:ownerId,kind:'upgrade',state:'prepared',target_plan:'full',target_price_id:'price_full',expected_subscription_id:sub.id,expected_customer_id:'cus_original',stripe_customer_id:'cus_original',stripe_subscription_id:null,stripe_item_id:'si_original',checkout_session_id:null,invoice_id:null,schedule_id:null,source_fingerprint:smsSubscriptionFingerprint(sub),source_plan:'chat_only',source_period_start:iso(start),source_period_end:iso(end),proration_at:iso(now),payment_effective_at:null,payment_verified_at:null,setup_fee_price_id:'price_setup',quote:{amountDueCents:5250,currency:'usd',monthlyPriceCents:6500,voiceSeconds:3000},created_at:iso(now),expires_at:iso(now+600),confirmed_at:null,applied_at:null};
 inv={id:'in_upgrade',customer:'cus_original',livemode:false,billing_reason:'subscription_update',currency:'usd',created:now,amount_due:5250,status:'paid',status_transitions:{paid_at:now},parent:{subscription_details:{subscription:'sub_original'}},lines:{has_more:false,data:lines()}} as unknown as Stripe.Invoice;
 m.context.mockImplementation(async()=>context());m.ready.mockImplementation(async()=>context());m.getUpgrade.mockImplementation(async()=>u);m.rollout.mockReturnValue(true);m.available.mockReturnValue(true);
 m.retrieve.mockImplementation(async()=>sub);m.invoice.mockImplementation(async()=>inv);m.list.mockImplementation(async()=>({data:[inv],has_more:false}));m.price.mockImplementation(async(id:string)=>price(id.slice(6)));m.preview.mockResolvedValue({amount_due:5250,currency:'usd'});
 m.from.mockImplementation(()=>{const q={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn()};q.select.mockReturnValue(q);q.eq.mockReturnValue(q);q.maybeSingle.mockImplementation(async()=>({data:op,error:null}));return q;});
 m.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
  if(name==='read_chat_texting_upgrade_setup')return {data:{setupFingerprint:'a'.repeat(32),revision:1},error:null};
  if(name==='acquire_chat_texting_upgrade_quote')return {data:op,error:null};
  if(name==='confirm_chat_texting_upgrade'){op={...op,state:'confirming',confirmed_at:iso(now)};u={...u,state:'payment_pending'};}
  if(name==='record_sms_billing_operation')op={...op,...args.p_details as object};
  if(name==='finalize_chat_texting_upgrade_payment'){op={...op,state:'applied',payment_effective_at:iso(now)};u={...u,state:'carrier_pending',paid_at:iso(now)};return {data:true,error:null};}
  return {data:op,error:null};
 });
 m.update.mockImplementation(async()=>{sub={...sub,metadata:{...sub.metadata,sms_billing_operation_id:opId,chat_texting_upgrade_id:upgradeId},latest_invoice:inv.id,items:{...sub.items,data:[{...sub.items.data[0],price:price(u.target_plan)}]}};return sub;});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('Chat to texting payment',()=>{
 it.each(['sms_only','sms_and_chat','full'] as const)('updates the same subscription with one operation-bound setup fee for %s',async target=>{
  u.target_plan=target;u.starter_acknowledged_at=iso(now);op.target_plan=target;op.target_price_id=`price_${target}`;inv.lines.data=lines();
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,true);
  expect(m.update).toHaveBeenCalledExactlyOnceWith('sub_original',expect.objectContaining({payment_behavior:'pending_if_incomplete',proration_behavior:'always_invoice',billing_cycle_anchor:'unchanged',proration_date:now,add_invoice_items:[{price:'price_setup',quantity:1,metadata:{chat_texting_upgrade_id:upgradeId,sms_billing_operation_id:opId}}]}),{idempotencyKey:`chat-texting-upgrade:${opId}`});
  expect(u.paid_at).toBe(iso(now));expect(u.activated_at).toBeNull();
 });
 it('never quotes or charges when setup is incomplete',async()=>{
  m.ready.mockRejectedValue(new Error('texting_upgrade_setup_incomplete'));
  await expect(quoteTextingUpgrade(businessId,ownerId)).rejects.toThrow('setup_incomplete');
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('setup_incomplete');
  expect(m.update).not.toHaveBeenCalled();expect(m.preview).not.toHaveBeenCalled();expect(m.price).not.toHaveBeenCalled();expect(m.rpc.mock.calls.every(([name])=>name==='read_chat_texting_upgrade_setup')).toBe(true);
 });
 it('requires Starter acknowledgement before any payment claim',async()=>{
  u.target_plan='sms_only';op.target_plan='sms_only';
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('starter_acknowledgement');expect(m.update).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
 });
 it.each(['amount','period','price','expired','canceled'])('rejects changed %s before charging',async change=>{
  if(change==='amount')m.preview.mockResolvedValue({amount_due:5260,currency:'usd'});
  if(change==='period')sub.items.data[0].current_period_end+=86400;
  if(change==='price')vi.stubEnv('STRIPE_PRICE_FULL','price_replacement');
  if(change==='expired')op.expires_at=iso(now-1);
  if(change==='canceled')sub.cancel_at_period_end=true;
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow();expect(m.update).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
 });
 it('blocks new confirmations while disabled but recovers a confirmed payment',async()=>{
  m.rollout.mockReturnValue(false);
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('disabled');
  op.state='confirming';op.confirmed_at=iso(now);u.state='payment_pending';
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);expect(op.state).toBe('applied');
 });
 it('keeps Chat on a decline and recovers the exact hosted invoice',async()=>{
  inv.status='open';inv.status_transitions.paid_at=null;inv.hosted_invoice_url='https://invoice.stripe.com/recover';
  m.update.mockImplementation(async()=>{sub={...sub,latest_invoice:inv.id,pending_update:{expires_at:now+3600} as Stripe.Subscription.PendingUpdate};return sub;});
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  expect(u.paid_at).toBeNull();expect(sub.items.data[0].price.id).toBe('price_chat_only');
  expect(await recoverTextingUpgradePayment(businessId,ownerId)).toBe('https://invoice.stripe.com/recover');
  expect(m.rpc.mock.calls.some(([name])=>name==='finalize_chat_texting_upgrade_payment')).toBe(false);
 });
 it('does not charge twice after a successful response is lost',async()=>{
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  expect(m.update).toHaveBeenCalledTimes(1);
 });
 it('replays an ambiguous request with the same idempotency key and exact parameters',async()=>{
  const original=m.update.getMockImplementation()!;m.update.mockImplementationOnce(async()=>{await original();throw new Error('network disconnected');});
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('disconnected');
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  expect(m.update.mock.calls[0]).toEqual(m.update.mock.calls[1]);expect(op.state).toBe('applied');
 });
 it('never substitutes the renewal invoice during delayed recovery',async()=>{
  op.state='pending';op.confirmed_at=iso(now);op.invoice_id=inv.id;u.state='payment_pending';
  sub.items.data[0].price=price('full');sub.items.data[0].current_period_start=end;sub.items.data[0].current_period_end=end+30*86400;sub.latest_invoice='in_later_renewal';
  vi.setSystemTime((end+100)*1000);await reconcileTextingUpgradePayment(u,op);
  expect(m.invoice).toHaveBeenCalledWith('in_upgrade');expect(m.invoice).not.toHaveBeenCalledWith('in_later_renewal');
  expect(m.rpc).toHaveBeenCalledWith('finalize_chat_texting_upgrade_payment',expect.objectContaining({p_details:expect.objectContaining({payment_period_start:iso(start),payment_period_end:iso(end),current_period_start:iso(end),invoice_id:'in_upgrade'})}));
 });
 it('recovers the invoice by its immutable fee marker after the update response was never saved',async()=>{
  op.state='confirming';op.confirmed_at=iso(now);u.state='payment_pending';sub.items.data[0].price=price('full');sub.latest_invoice='in_later';
  await reconcileTextingUpgradePayment(u,op);expect(op.invoice_id).toBe('in_upgrade');expect(m.list).toHaveBeenCalled();
 });
 it('refuses a replacement charge outside the safe retry window when money is unresolved',async()=>{
  op.state='confirming';op.confirmed_at=iso(now-24*3600);u.state='payment_pending';m.list.mockResolvedValue({data:[],has_more:false});
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('payment_unresolved');expect(m.update).not.toHaveBeenCalled();
 });
 it.each(['identity','fee','operation','proration','amount'])('rejects invalid invoice %s evidence',async part=>{
  op.confirmed_at=iso(now);
  if(part==='identity')inv.customer='cus_other';
  if(part==='fee')inv.lines.data[0].amount=2499;
  if(part==='operation')inv.lines.data[0].metadata.sms_billing_operation_id='another';
  if(part==='proration')inv.lines.data[1].period.end+=100;
  if(part==='amount')inv.amount_due=6000;
  expect(()=>verifyTextingUpgradeInvoice(inv,inv.lines.data,op,u)).toThrow();
 });
 it('requires a conclusive void before abandoning unpaid work',async()=>{
  op.state='pending';op.invoice_id=inv.id;op.confirmed_at=iso(now);u.state='payment_pending';inv.status='open';inv.status_transitions.paid_at=null;
  m.void.mockRejectedValue(new Error('ambiguous void'));
  await expect(cancelTextingUpgrade(businessId,ownerId)).rejects.toThrow('ambiguous void');
  expect(m.rpc.mock.calls.some(([name])=>name==='cancel_chat_texting_upgrade')).toBe(false);
 });
 it('preserves payment evidence after cancellation and never resets the plan family',async()=>{
  op.state='pending';op.confirmed_at=iso(now);op.invoice_id=inv.id;u.state='payment_pending';sub.items.data[0].price=price('full');sub.status='canceled';
  await reconcileTextingUpgradePayment(u,op);
  expect(m.rpc).toHaveBeenCalledWith('finalize_chat_texting_upgrade_payment',expect.objectContaining({p_details:expect.objectContaining({status:'canceled'})}));
 });
 it('interprets authorized transition before stale Chat metadata',async()=>{
  op.state='applied';u.paid_at=iso(now);u.state='carrier_pending';sub.items.data[0].price=price('full');sub.metadata.sms_billing_operation_id=opId;
  const result=await synchronizeTextingUpgradeSubscription(sub);
  expect(result.paid).toBe(true);expect(result.owned).toBe(true);expect(result.subscription.metadata.plan).toBeUndefined();expect(result.subscription.metadata.checkout_attempt_id).toBeUndefined();expect(sub.metadata.plan).toBe('chat_only');
 });
 it('lets future SMS changes use their own operation after activation',async()=>{
  op.state='applied';u.paid_at=iso(now);u.activated_at=iso(now);u.state='activated';sub.items.data[0].price=price('full');sub.metadata.sms_billing_operation_id='later-sms-operation';
  const result=await synchronizeTextingUpgradeSubscription(sub);expect(result.owned).toBe(false);expect(result.paid).toBe(true);
 });
});
