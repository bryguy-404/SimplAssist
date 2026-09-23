import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({transition:vi.fn(),rpc:vi.fn(),from:vi.fn(),retrieve:vi.fn(),voice:vi.fn(),continueRegistration:vi.fn(),sms:vi.fn(),finish:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./textingUpgrade.server',()=>({synchronizeTextingUpgradeSubscription:m.transition}));
vi.mock('./client',()=>({stripe:{subscriptions:{retrieve:m.retrieve}}}));
vi.mock('./voiceSubscription.server',()=>({prepareVoiceSubscription:m.voice}));
vi.mock('./smsBilling.server',()=>({synchronizeSmsBillingOperation:m.sms,finishSmsDowngrade:m.finish}));
vi.mock('@/lib/billing/textingUpgradeReconciliation.server',()=>({continueTextingUpgradeRegistration:m.continueRegistration}));
vi.mock('@/lib/supabase/admin',()=>({supabaseAdmin:{rpc:m.rpc,from:m.from}}));
import { syncCheckoutSession, syncStripeSubscription } from './subscriptionSync';
const businessId='10000000-0000-4000-8000-000000000001',attemptId='20000000-0000-4000-8000-000000000002',operationId='30000000-0000-4000-8000-000000000003';
const expiry=1800000000;
const chatMetadata={business_id:businessId,plan:'chat_only',mode:'onboarding',checkout_attempt_id:attemptId,checkout_request_fingerprint:'a'.repeat(64),checkout_session_expires_at:new Date(expiry*1000).toISOString()};
let live:Stripe.Subscription;
beforeEach(()=>{
 vi.resetAllMocks();vi.stubEnv('STRIPE_PRICE_SMS_ONLY','price_sms_only');vi.stubEnv('STRIPE_PRICE_SMS_AND_CHAT','price_sms_and_chat');vi.stubEnv('STRIPE_PRICE_FULL','price_full');vi.stubEnv('STRIPE_PRICE_CHAT_ONLY','price_chat');
 live={id:'sub_original',customer:'cus_original',status:'active',cancel_at_period_end:false,metadata:{...chatMetadata,sms_billing_operation_id:operationId},items:{data:[{quantity:1,price:{id:'price_sms_only'},current_period_start:1770000000,current_period_end:1772592000}]}} as unknown as Stripe.Subscription;
 m.transition.mockImplementation(async()=>({owned:true,paid:true,subscription:live}));m.retrieve.mockImplementation(async()=>live);m.voice.mockImplementation(async()=>({subscription:live,revision:null,observedAt:null}));m.rpc.mockResolvedValue({data:true,error:null});m.sms.mockResolvedValue(false);
});
afterEach(()=>vi.unstubAllEnvs());
describe('authorized Chat transition synchronization',()=>{
 it('ignores retained Chat metadata even when the voice read returns it again',async()=>{
  expect(await syncStripeSubscription(live)).toMatchObject({plan:'sms_only'});
  expect(m.rpc).toHaveBeenCalledWith('sync_stripe_subscription_if_business_active',expect.objectContaining({p_plan:'sms_only',p_stripe_subscription_id:'sub_original'}));
  expect(m.rpc.mock.calls.some(([name])=>name==='sync_chat_only_subscription_from_attempt')).toBe(false);
  expect(m.sms).not.toHaveBeenCalled();expect(m.continueRegistration).toHaveBeenCalledOnce();
 });
 it('defers registration when the refresh orchestrator owns the single continuation',async()=>{
  await syncStripeSubscription(live,{deferTextingUpgradeRegistration:true});expect(m.continueRegistration).not.toHaveBeenCalled();
 });
 it('acknowledges an old Chat checkout without repeating signup finalization',async()=>{
  const session={id:'cs_original',customer:'cus_original',subscription:'sub_original',client_reference_id:businessId,metadata:chatMetadata,status:'complete',payment_status:'paid',mode:'subscription',expires_at:expiry} as unknown as Stripe.Checkout.Session;
  expect(await syncCheckoutSession(session)).toBeNull();
  expect(m.rpc.mock.calls.some(([name])=>name==='complete_chat_only_checkout_attempt'||name==='finalize_chat_only_onboarding_if_paid')).toBe(false);
 });
 it('retains canceled status and does not treat an old paid checkout as renewed authority',async()=>{
  live.status='canceled';await syncStripeSubscription(live);
  expect(m.rpc).toHaveBeenCalledWith('sync_stripe_subscription_if_business_active',expect.objectContaining({p_status:'canceled',p_plan:'sms_only'}));
 });
 it('dispatches later SMS tier changes through their normal operation',async()=>{
  m.transition.mockResolvedValue({owned:false,paid:true,subscription:live});await syncStripeSubscription(live);expect(m.sms).toHaveBeenCalledWith(live);
 });
});
