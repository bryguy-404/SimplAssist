import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextingUpgradeRecord } from "@/lib/billing/textingUpgrade";
import type { SmsBillingOperation } from "./smsBilling.server";
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), retrieve: vi.fn(), update: vi.fn(), invoice: vi.fn(), list: vi.fn(), lines: vi.fn(), preview: vi.fn(), price: vi.fn(), context: vi.fn(), ready: vi.fn(), getUpgrade: vi.fn(), void: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: m.from, rpc: m.rpc } }));
vi.mock("./client", () => ({ stripe: { subscriptions: { retrieve: m.retrieve, update: m.update }, prices: { retrieve: m.price }, invoices: { retrieve: m.invoice, list: m.list, listLineItems: m.lines, createPreview: m.preview, voidInvoice: m.void } } }));
vi.mock("@/lib/billing/textingUpgradeStore.server", () => ({ getTextingUpgrade: m.getUpgrade, textingUpgradeRpc: async (name: string, args: unknown) => { const r = await m.rpc(name,args); if(r.error) throw new Error(r.error.message); return r.data; } }));
vi.mock("@/lib/billing/textingUpgrade.server", () => ({ loadTextingUpgradeContext: m.context, requireTextingUpgradeReady: m.ready, textingUpgradeQuote: (op: SmsBillingOperation) => ({ operationId: op.id, ...op.quote }) }));
vi.mock("./config", () => ({ REVIEW_SMS_ADDON_CENTS: 2000, SETUP_FEE_CENTS:2500, SUBSCRIPTION_PLANS: { sms_and_chat:{price:49},chat_only:{price:15},full:{price:79} },
  stripePriceIdForPlan: (plan: string) => `price_${plan}`, stripeSetupFeePriceId: () => 'price_setup', planFromStripePriceId: (price: string) => price === 'price_chat_only' ? 'chat_only' : 'sms_and_chat' }));
vi.mock("./chatOnlyPrice", () => ({ assertApprovedChatOnlyStripePrice: (price: Stripe.Price) => { if(price.id !== 'price_chat_only' || price.unit_amount !== 1500) throw new Error('invalid_chat_price'); } }));
import { cancelTextingUpgrade, confirmTextingUpgrade, quoteTextingUpgrade, reconcileTextingUpgradePayment, synchronizeTextingUpgradeSubscription } from "./textingUpgrade.server";
import { verifyReviewConversionInvoice } from "./reviewConversion.server";
import { smsSubscriptionFingerprint } from "./smsBilling.server";
const businessId='10000000-0000-4000-8000-000000000001',ownerId='20000000-0000-4000-8000-000000000002',upgradeId='30000000-0000-4000-8000-000000000003',opId='40000000-0000-4000-8000-000000000004';
const now=Date.parse('2026-10-04T12:00:00Z')/1000,start=now-15*86400,end=now+15*86400,iso=(t:number)=>new Date(t*1000).toISOString();
let u:TextingUpgradeRecord,op:SmsBillingOperation,sub:Stripe.Subscription,invoice:Stripe.Invoice,sourceInvoice:Stripe.Invoice;
const price=(name:string)=>({id:`price_${name}`,active:true,currency:'usd',type:'recurring',unit_amount:name==='chat_only'?1500:name==='reviews'?2000:4900,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}} as Stripe.Price);
function line(item:string, name:string, amount:number){return {id:`il_${name}`,quantity:1,amount,pricing:{price_details:{price:`price_${name}`}},period:{start:now,end},parent:{subscription_item_details:{proration:true,subscription_item:item}}} as Stripe.InvoiceLineItem;}
function context(){return {upgrade:u,operation:op,eligible:true};}
function applyProvider(){sub={...sub,metadata:{...sub.metadata,sms_billing_operation_id:opId,chat_texting_upgrade_id:upgradeId},latest_invoice:invoice.id,items:{...sub.items,data:[{...sub.items.data[0],price:price('sms_and_chat')}]}};return sub;}
beforeEach(()=>{
 vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(now*1000);vi.stubEnv('STRIPE_SECRET_KEY','sk_test_fixture');vi.stubEnv('STRIPE_PRICE_REVIEW_SMS','price_reviews');
 u={id:upgradeId,business_id:businessId,owner_id:ownerId,source_subscription_id:'sub_source',source_customer_id:'cus_source',target_plan:'sms_and_chat',state:'draft',
  source_mode:'review_sms',source_review_account_id:'50000000-0000-4000-8000-000000000005',source_review_item_id:'si_reviews',original_activation_operation_id:'60000000-0000-4000-8000-000000000006',
  billing_operation_id:opId,business_confirmed_at:null,phone_confirmed_at:null,starter_acknowledged_at:null,paid_at:null,activated_at:null,created_at:iso(now),updated_at:iso(now)};
 sub={id:'sub_source',customer:'cus_source',livemode:false,status:'active',cancel_at_period_end:false,schedule:null,pending_update:null,discounts:[],collection_method:'charge_automatically',metadata:{business_id:businessId,plan:'chat_only',checkout_attempt_id:'initial-chat'},latest_invoice:'in_source',
  items:{has_more:false,data:[{id:'si_chat',price:price('chat_only'),quantity:1,current_period_start:start,current_period_end:end},{id:'si_reviews',price:price('reviews'),quantity:1,current_period_start:start,current_period_end:end}]}} as unknown as Stripe.Subscription;
 op={id:opId,business_id:businessId,owner_id:ownerId,kind:'upgrade',state:'prepared',target_plan:'sms_and_chat',target_price_id:'price_sms_and_chat',expected_subscription_id:sub.id,expected_customer_id:'cus_source',stripe_customer_id:'cus_source',stripe_subscription_id:null,stripe_item_id:'si_chat',checkout_session_id:null,invoice_id:null,schedule_id:null,source_fingerprint:smsSubscriptionFingerprint(sub),source_plan:'chat_only',source_period_start:iso(start),source_period_end:iso(end),proration_at:iso(now),payment_effective_at:null,payment_verified_at:null,setup_fee_price_id:null,
  quote:{amountDueCents:700,currency:'usd',monthlyPriceCents:4900,setupFeeCents:0,sourceMode:'review_sms',sourceBasePriceId:'price_chat_only',sourceReviewPriceId:'price_reviews',sourceReviewItemId:'si_reviews'},created_at:iso(now),expires_at:iso(now+600),confirmed_at:null,applied_at:null};
 invoice={id:'in_conversion',customer:'cus_source',livemode:false,status:'paid',status_transitions:{paid_at:now},billing_reason:'subscription_update',currency:'usd',created:now,amount_due:700,parent:{subscription_details:{subscription:sub.id,metadata:{sms_billing_operation_id:opId,chat_texting_upgrade_id:upgradeId}}},lines:{has_more:false,data:[line('si_chat','chat_only',-750),line('si_reviews','reviews',-1000),line('si_chat','sms_and_chat',2450)]}} as unknown as Stripe.Invoice;
 sourceInvoice={...invoice,id:'in_source',lines:{...invoice.lines,data:[line('si_chat','chat_only',1500),line('si_reviews','reviews',2000)].map(l=>({...l,period:{start,end},parent:{...l.parent!,subscription_item_details:{...l.parent!.subscription_item_details!,proration:false}}}))}};
 m.context.mockImplementation(async()=>context());m.ready.mockImplementation(async()=>context());m.getUpgrade.mockImplementation(async()=>u);m.retrieve.mockImplementation(async()=>sub);m.price.mockImplementation(async()=>price('sms_and_chat'));m.preview.mockResolvedValue({amount_due:700,currency:'usd'});
 m.invoice.mockImplementation(async(invoiceId:string)=>invoiceId==='in_source'?{...invoice,id:invoiceId}:invoice);
 m.list.mockImplementation(async(args:{status?:string})=>({data:args.status==='open'?[]:args.status==='paid'?[sourceInvoice]:[invoice],has_more:false}));
 m.from.mockImplementation(()=>{const q={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn()};q.select.mockReturnValue(q);q.eq.mockReturnValue(q);q.maybeSingle.mockImplementation(async()=>({data:op,error:null}));return q;});
 m.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
  if(name==='read_chat_texting_upgrade_setup')return {data:{setupFingerprint:'a'.repeat(32)},error:null};
  if(name==='confirm_chat_texting_upgrade'){op={...op,state:'confirming',confirmed_at:iso(now)};u={...u,state:'payment_pending'};}
  if(name==='record_sms_billing_operation')op={...op,...args.p_details as object};
  if(name==='finalize_chat_texting_upgrade_payment'){op={...op,state:'applied'};u={...u,state:'activated',paid_at:iso(now),activated_at:iso(now)};return {data:true,error:null};}
  if(name==='expire_review_texting_upgrade_payment')u={...u,state:'draft'};
  if(name==='cancel_chat_texting_upgrade')u={...u,state:'abandoned'};
  return {data:op,error:null};
 });
 m.update.mockImplementation(async()=>applyProvider());
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('paid review SMS to Growth',()=>{
 it('quotes a single Growth plan replacing both source items without a setup fee',async()=>{
  await quoteTextingUpgrade(businessId,ownerId);
  expect(m.preview).toHaveBeenCalledWith(expect.objectContaining({subscription_details:expect.objectContaining({items:[{id:'si_chat',price:'price_sms_and_chat',quantity:1},{id:'si_reviews',deleted:true}],billing_cycle_anchor:'unchanged'})}));
  expect(m.rpc).toHaveBeenCalledWith('acquire_chat_texting_upgrade_quote',expect.objectContaining({p_request:expect.objectContaining({setup_fee_price_id:null,quote:expect.objectContaining({setupFeeCents:0,amountDueCents:700})})}));
 });
 it('replaces two items with one, credits both unused portions and activates once',async()=>{
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  expect(m.update).toHaveBeenCalledTimes(1);
  expect(m.update.mock.calls[0][1]).toEqual({items:[{id:'si_chat',price:'price_sms_and_chat',quantity:1},{id:'si_reviews',deleted:true}],payment_behavior:'pending_if_incomplete',proration_behavior:'always_invoice',proration_date:now,billing_cycle_anchor:'unchanged',metadata:{sms_billing_operation_id:opId,chat_texting_upgrade_id:upgradeId}});
  expect(u.state).toBe('activated');expect(sub.items.data).toHaveLength(1);
 });
 it('requires completed carrier handoff before any quote or payment claim',async()=>{
  m.rpc.mockResolvedValue({data:null,error:null});m.ready.mockRejectedValue(new Error('texting_upgrade_provider_pending'));
  await expect(quoteTextingUpgrade(businessId,ownerId)).rejects.toThrow('provider_pending');
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('provider_pending');
  expect(m.update).not.toHaveBeenCalled();expect(m.preview).not.toHaveBeenCalled();
 });
 it.each(['customer','addon','amount','schedule','cancel','unpaid','extra item'])('rejects changed %s before billing',async(change)=>{
  if(change==='customer')sub.customer='cus_other';if(change==='addon')sub.items.data[1].id='si_other';if(change==='amount')m.preview.mockResolvedValue({amount_due:701,currency:'usd'});
  if(change==='schedule')sub.schedule='sub_sched_other';if(change==='cancel')sub.cancel_at_period_end=true;
  if(change==='unpaid')sourceInvoice.status='open';if(change==='extra item')sub.items.data.push(sub.items.data[1]);
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow();expect(m.update).not.toHaveBeenCalled();
 });
 it('can quote again after a voided upgrade while both current source items remain paid',async()=>{
  sub.latest_invoice='in_void';m.invoice.mockResolvedValue({...invoice,id:'in_void',status:'void'});
  await expect(quoteTextingUpgrade(businessId,ownerId)).resolves.toBeDefined();
  expect(m.invoice).not.toHaveBeenCalledWith('in_void');
 });
 it.each(['missing addon','old period','other item','open invoice'])('rejects incomplete current source receipt: %s',async(kind)=>{
  if(kind==='missing addon')sourceInvoice.lines.data.pop();
  if(kind==='old period')sourceInvoice.lines.data[0].period.end--;
  if(kind==='other item')sourceInvoice.lines.data[1].parent!.subscription_item_details!.subscription_item='si_other';
  if(kind==='open invoice')m.list.mockResolvedValue({data:[sourceInvoice],has_more:false});
  await expect(quoteTextingUpgrade(businessId,ownerId)).rejects.toThrow('source_unpaid');
 });
 it('accepts a paid addon activated partway through the same source period',async()=>{
  sourceInvoice.lines.data[1].period.start=now-86400;
  sourceInvoice.lines.data[1].parent!.subscription_item_details!.proration=true;
  await expect(quoteTextingUpgrade(businessId,ownerId)).resolves.toBeDefined();
 });
 it('keeps both source items on decline and does not finalize an unpaid invoice',async()=>{
  invoice.status='open';invoice.status_transitions.paid_at=null;m.invoice.mockImplementation(async(i:string)=>i==='in_source'?{...invoice,id:i,status:'paid'}:invoice);
  m.update.mockImplementation(async()=>{sub={...sub,latest_invoice:invoice.id,pending_update:{expires_at:now+3600} as Stripe.Subscription.PendingUpdate};return sub;});
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  expect(sub.items.data).toHaveLength(2);expect(u.paid_at).toBeNull();expect(op.state).toBe('pending');
 });
 it('retries a lost update response with exactly the same immutable request',async()=>{
  m.update.mockImplementationOnce(async()=>{applyProvider();throw new Error('connection lost');});
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('connection lost');
  await confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false);
  expect(m.update.mock.calls[0]).toEqual(m.update.mock.calls[1]);expect(u.state).toBe('activated');
 });
 it('recovers immutable invoice identity after later renewal instead of latest_invoice',async()=>{
  op.state='confirming';op.confirmed_at=iso(now);u.state='payment_pending';applyProvider();sub.latest_invoice='in_renewal';
  sub.items.data[0].current_period_start=end;sub.items.data[0].current_period_end=end+30*86400;vi.setSystemTime((end+100)*1000);
  await reconcileTextingUpgradePayment(u,op);expect(op.invoice_id).toBe('in_conversion');
  expect(m.invoice).not.toHaveBeenCalledWith('in_renewal');
  expect(m.rpc).toHaveBeenCalledWith('finalize_chat_texting_upgrade_payment',expect.objectContaining({p_details:expect.objectContaining({current_period_start:iso(end),payment_period_start:iso(start)})}));
 });
 it('does not mint a fresh charge after the idempotency retention safety window',async()=>{
  op.state='confirming';op.confirmed_at=iso(now-24*3600);u.state='payment_pending';m.list.mockResolvedValue({data:[],has_more:false});
  await expect(confirmTextingUpgrade(businessId,ownerId,opId,op.source_fingerprint,false)).rejects.toThrow('payment_unresolved');expect(m.update).not.toHaveBeenCalled();
 });
 it.each(['snapshot','credit','extra fee','period','amount','other invoice'])('rejects tampered invoice %s proof',part=>{
  op.confirmed_at=iso(now);
  if(part==='snapshot')invoice.parent!.subscription_details!.metadata={};if(part==='credit')invoice.lines.data[1].amount=1000;
  if(part==='extra fee')invoice.lines.data.push(line('si_chat','setup',2500));if(part==='period')invoice.lines.data[0].period.end++;
  if(part==='amount')invoice.amount_due++;if(part==='other invoice')op.invoice_id='in_other';
  expect(()=>verifyReviewConversionInvoice(invoice,invoice.lines.data,op,u)).toThrow();
 });
 it('voids only the bound unpaid invoice and returns to source billing before abandonment',async()=>{
  op.state='pending';op.confirmed_at=iso(now);op.invoice_id=invoice.id;u.state='payment_pending';invoice.status='open';invoice.status_transitions.paid_at=null;
  m.void.mockImplementation(async()=>{invoice.status='void';sub.pending_update=null;return invoice;});
  await cancelTextingUpgrade(businessId,ownerId);expect(m.void).toHaveBeenCalledWith('in_conversion',{}, {idempotencyKey:`chat-texting-void:${opId}`});
  expect(op.state).toBe('expired');expect(u.state).toBe('abandoned');expect(sub.items.data).toHaveLength(2);
 });
 it('preserves canceled provider state when paid recovery is late',async()=>{
  op.state='pending';op.confirmed_at=iso(now);op.invoice_id=invoice.id;u.state='payment_pending';applyProvider();sub.status='canceled';
  await reconcileTextingUpgradePayment(u,op);expect(m.rpc).toHaveBeenCalledWith('finalize_chat_texting_upgrade_payment',expect.objectContaining({p_details:expect.objectContaining({status:'canceled'})}));
 });
 it('supersedes initial Chat metadata but permits subsequent Growth to Full operations',async()=>{
  op.state='applied';u.state='activated';u.paid_at=iso(now);u.activated_at=iso(now);applyProvider();
  let result=await synchronizeTextingUpgradeSubscription(sub);expect(result.paid).toBe(true);expect(result.subscription.metadata.plan).toBeUndefined();
  sub.metadata.sms_billing_operation_id='later_operation';sub.items.data[0].price=price('full');
  result=await synchronizeTextingUpgradeSubscription(sub);expect(result.owned).toBe(false);expect(result.paid).toBe(true);
 });
});
