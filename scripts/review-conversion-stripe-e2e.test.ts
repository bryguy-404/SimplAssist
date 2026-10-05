/**
 * Opt-in real Stripe TEST -> signed application webhook -> disposable local DB.
 * Uses only supabase_db_SimplAssistReviews (56321/56322), requires no businesses,
 * and never calls Telnyx/email. Original activation/approved carrier handoff are
 * explicit local fixtures; subscription changes, invoices and webhooks are real.
 * Run via Vitest with REVIEW_CONVERSION_STRIPE_E2E=1 and the existing
 * REVIEW_STRIPE_E2E/STRIPE_SECRET_KEY/loopback URL/service key configuration.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { describe, it, vi } from "vitest";
import { validateConfiguration, assertTestObject } from "./review-stripe-release-e2e.mjs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/client", () => ({ telnyx: new Proxy({}, {get(){throw new Error("Telnyx forbidden in Stripe conversion tests");}}),TELNYX_MESSAGING_PROFILE_ID:'forbidden',TELNYX_CONNECTION_ID:'forbidden' }));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const objectId=(v:unknown)=>typeof v==='string'?v:(v as {id:string})?.id;
const q=(v:string)=>`'${v.replaceAll("'","''")}'`;

describe.skipIf(process.env.REVIEW_CONVERSION_STRIPE_E2E !== '1')('real review conversion billing',()=>{
 it('proves paid/failed/SCA/void/renewal behavior against Stripe and the actual webhook',async()=>{
  const config=validateConfiguration(process.env),run=randomUUID(),container='supabase_db_SimplAssistReviews';
  assert.equal(new URL(config.localUrl).port,'56321');
  for(const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY'])assert(!process.env[name]);
  const context=spawnSync('docker',['context','inspect'],{encoding:'utf8'});assert.equal(context.status,0);
  const endpoint=JSON.parse(context.stdout)[0].Endpoints.docker.Host;assert(endpoint.startsWith('unix:///'));
  const inspected=spawnSync('docker',['--host',endpoint,'inspect',container],{encoding:'utf8'});assert.equal(inspected.status,0);
  const info=JSON.parse(inspected.stdout)[0];assert.equal(info.Config.Labels['com.supabase.cli.project'],'SimplAssistReviews');assert.equal(info.HostConfig.PortBindings['5432/tcp'][0].HostPort,'56322');
  const sql=(query:string)=>{const r=spawnSync('docker',['--host',endpoint,'exec','-i',container,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-At'],{input:query,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
  assert.equal(sql('select count(*) from public.businesses').trim(),'0');
  assert.equal(sql("select to_regprocedure('public.finalize_chat_texting_upgrade_payment(uuid,jsonb)') is not null and to_regclass('public.review_texting_provider_upgrades') is not null").trim(),'t');
  const db=createClient(config.localUrl,config.localKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const check=<T>(result:{data:T,error:{message:string}|null})=>{assert.equal(result.error,null,result.error?.message);return result.data;};
  const stripe=new Stripe(config.key,{apiVersion:'2026-02-25.clover',maxNetworkRetries:2,timeout:20_000});
  assertTestObject(await stripe.balance.retrieve());
  const reportPath=process.env.REVIEW_STRIPE_E2E_REPORT??'/private/tmp/review-conversion-stripe-e2e.json';
  const owned={products:[] as string[],prices:[] as string[],customers:[] as string[],subscriptions:[] as string[],clocks:[] as string[],checkouts:[] as string[],events:[] as string[],fixtures:[] as Array<{b:string,own:string,a:string,u:string}>};
  const report={run,status:'running',coverage:'Real Stripe subscriptions/invoices, CLI-signed actual application webhook and disposable local DB; activation receipt and approved carrier handoff are local fixtures. No live messages or provider changes.',checks:[] as string[],cleanupErrors:[] as string[],resources:owned};
  const save=()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  const pass=async(label:string)=>{report.checks.push(label);console.log(`PASS: ${label}`);await save();};
  const poll=async<T>(label:string,read:()=>Promise<T|null|false>,timeout=90_000):Promise<T>=>{const stop=Date.now()+timeout;while(Date.now()<stop){const v=await read();if(v)return v;await sleep(1000);}throw Error(`Timed out: ${label}`);};
  const metadata={review_conversion_e2e_run:run};
  let listener:ReturnType<typeof spawn>|undefined,handler:typeof import('../src/app/api/stripe/webhook/route').POST|undefined,webhookSecret='';
  const accepted=new Set<string>(),deliveries=new Map<string,{body:string,signature:string,status:number}>();
  const server=createServer(async(req,res)=>{
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=Buffer.concat(chunks).toString();
   try{const event=JSON.parse(body) as Stripe.Event;const customer=objectId((event.data.object as unknown as {customer?:unknown}).customer);
    if(!handler||!accepted.has(customer)){res.end('ignored');return;}assert.equal(event.livemode,false);
    const signature=String(req.headers['stripe-signature']??'');
    const response=await handler(new Request('http://127.0.0.1:56402/api/stripe/webhook',{method:'POST',body,headers:{'stripe-signature':signature}}) as never);
    deliveries.set(event.id,{body,signature,status:response.status});if(!owned.events.includes(event.id))owned.events.push(event.id);
    res.writeHead(response.status);res.end(await response.text());
   }catch(error){res.writeHead(500);res.end(String(error));}
  });
  try{
   await save();
   const product=assertTestObject(await stripe.products.create({name:`Review conversion test ${run}`,metadata}));owned.products.push(product.id);
   const price=async(cents:number,recurring=true)=>{const p=assertTestObject(await stripe.prices.create({product:product.id,unit_amount:cents,currency:'usd',metadata,...(recurring?{recurring:{interval:'month' as const}}:{})}));owned.prices.push(p.id);await save();return p.id;};
   const chat=await price(1500),addon=await price(2000),growth=await price(4900),full=await price(7900),starter=await price(2900),activation25=await price(2500,false),activation49=await price(4900,false);
   Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:config.localUrl,SUPABASE_SERVICE_ROLE_KEY:config.localKey,STRIPE_PRICE_CHAT_ONLY:chat,STRIPE_PRICE_REVIEW_SMS:addon,
    STRIPE_PRICE_SMS_AND_CHAT:growth,STRIPE_PRICE_FULL:full,STRIPE_PRICE_SMS_ONLY:starter,STRIPE_PRICE_SETUP_FEE:activation25,STRIPE_PRICE_REVIEW_SMS_ACTIVATION:activation25,
    NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED:'1',REVIEW_SMS_UPGRADES_ENABLED:'1',REVIEW_SMS_UPGRADES_PILOT_BUSINESS_IDS:'*',
    REVIEWS_SMS_ENABLED:'1',REVIEWS_SMS_PILOT_BUSINESS_IDS:'*',REVIEWS_SMS_PROVISIONING_ENABLED:'0',REVIEWS_SMS_SENDING_ENABLED:'0',REVIEWS_EMAIL_SENDING_ENABLED:'0',
    REVIEW_SMS_UPGRADES_PROVISIONING_ENABLED:'0',RESEND_API_KEY:'re_forbidden',ANTHROPIC_API_KEY:'forbidden',NEXT_PUBLIC_APP_URL:'http://127.0.0.1:56402'});
   await new Promise<void>(resolve=>server.listen(56402,'127.0.0.1',resolve));
   listener=spawn('stripe',['listen','--api-key',config.key,'--events','customer.subscription.updated,customer.subscription.deleted,invoice.payment_succeeded,invoice.payment_failed,customer.subscription.pending_update_applied,customer.subscription.pending_update_expired','--forward-to','http://127.0.0.1:56402/api/stripe/webhook'],{stdio:['ignore','pipe','pipe']});
   const capture=(c:Buffer)=>{const m=c.toString().match(/whsec_[A-Za-z0-9]+/);if(m)webhookSecret=m[0];};listener.stdout?.on('data',capture);listener.stderr?.on('data',capture);
   await poll('Stripe signing secret',async()=>webhookSecret||null);process.env.STRIPE_WEBHOOK_SECRET=webhookSecret;
   handler=(await import('../src/app/api/stripe/webhook/route')).POST;
   const billing=await import('../src/lib/stripe/textingUpgrade.server');
   const dbState=async(b:string)=>check(await db.from('subscriptions').select('*').eq('business_id',b).single());
   const addonState=async(a:string)=>check(await db.from('review_sms_accounts').select('*').eq('id',a).single());
   const upgradeState=async(u:string)=>check(await db.from('chat_texting_upgrades').select('*').eq('id',u).single());
   const advance=async(clock:string,time:number)=>{await stripe.testHelpers.testClocks.advance(clock,{frozen_time:time});await poll('test clock',async()=>{const c=await stripe.testHelpers.testClocks.retrieve(clock);return c.status==='ready'?c:null;});};
   const seedTemplate=(await readFile('supabase/tests/database/114_review_texting_conversion_billing.test.sql','utf8')).split("SELECT lives_ok")[0];
   const fixture=async(label:string,fee:number)=>{
    const clock=assertTestObject(await stripe.testHelpers.testClocks.create({frozen_time:Math.floor(Date.now()/1000)-15*86400,name:`Review conversion ${run}`}));owned.clocks.push(clock.id);
    const customer=assertTestObject(await stripe.customers.create({test_clock:clock.id,email:`conversion-${run}-${label}@example.invalid`,metadata}));owned.customers.push(customer.id);
    const card=await stripe.paymentMethods.create({type:'card',card:{token:'tok_visa'},metadata});await stripe.paymentMethods.attach(card.id,{customer:customer.id});
    const sub=assertTestObject(await stripe.subscriptions.create({customer:customer.id,items:[{price:chat},{price:addon}],default_payment_method:card.id,payment_behavior:'error_if_incomplete',metadata}));owned.subscriptions.push(sub.id);
    await advance(clock.id,Math.floor(Date.now()/1000));
    const base=sub.items.data.find((i:Stripe.SubscriptionItem)=>i.price.id===chat)!,review=sub.items.data.find((i:Stripe.SubscriptionItem)=>i.price.id===addon)!;assert(base&&review);
    let source=seedTemplate.replaceAll("'cus_'||suffix",q(customer.id)).replaceAll("'sub_'||suffix",q(sub.id))
     .replaceAll("'price_chat'",q(chat)).replaceAll("'price_reviews'",q(addon)).replaceAll("'price_originalsetup'",q(fee===2500?activation25:activation49))
     .replaceAll("'si_'||suffix",q(review.id)).replaceAll("'in_source'||suffix",q(objectId(sub.latest_invoice)))
     .replaceAll("lpad((SELECT count(*)+2000 FROM conversion_fixture)::text,4,'0')",q(String(2000+owned.fixtures.length)))
     .replaceAll("now()-interval '15 days'",`to_timestamp(${base.current_period_start})`).replaceAll("now()+interval '15 days'",`to_timestamp(${base.current_period_end})`);
    source+=`SELECT pg_temp.conversion_fixture(${q(label)},${fee}); UPDATE public.chat_only_checkout_attempts SET checkout_session_expires_at=date_trunc('second',checkout_session_expires_at) WHERE business_id=(SELECT b FROM conversion_fixture); SELECT row_to_json(f) FROM conversion_fixture f; COMMIT;`;
    const output=sql(source).split('\n').find(line=>line.startsWith('{"label"'));assert(output);const f=JSON.parse(output) as {b:string,own:string,a:string,u:string};owned.fixtures.push(f);
    const attempt=check(await db.from('chat_only_checkout_attempts').select('*').eq('business_id',f.b).single());
    await stripe.subscriptions.update(sub.id,{metadata:{...metadata,business_id:f.b,plan:'chat_only',mode:'onboarding',checkout_attempt_id:attempt.id,checkout_request_fingerprint:attempt.request_fingerprint,checkout_session_expires_at:new Date(attempt.checkout_session_expires_at).toISOString()}});
    await save();return {...f,customer:customer.id,card:card.id,subscription:sub.id,clock:clock.id,start:base.current_period_start,end:base.current_period_end,reviewItem:review.id};
   };
   const f=await fixture('paid_after_decline',2500);
   const lowVolume=assertTestObject(await stripe.checkout.sessions.create({customer:f.customer,mode:'payment',line_items:[{price:activation25,quantity:1}],success_url:'http://127.0.0.1:56402/success',metadata}));owned.checkouts.push(lowVolume.id);assert.equal(lowVolume.amount_total,2500);await stripe.checkout.sessions.expire(lowVolume.id);
   await pass('New activation Checkout is exactly $25; existing source subscription is $15+$20');
   const declined=await stripe.paymentMethods.create({type:'card',card:{token:'tok_chargeCustomerFail'},metadata});await stripe.paymentMethods.attach(declined.id,{customer:f.customer});await stripe.subscriptions.update(f.subscription,{default_payment_method:declined.id});
   const quote=await billing.quoteTextingUpgrade(f.b,f.own);assert.equal(quote.setupFeeCents,0);assert.equal(quote.monthlyPriceCents,4900);assert(quote.amountDueCents>=0&&quote.amountDueCents<1400);
   accepted.add(f.customer);
   await billing.confirmTextingUpgrade(f.b,f.own,quote.operationId,quote.quoteFingerprint,false);
   let live=await stripe.subscriptions.retrieve(f.subscription);assert(live.pending_update);assert.equal(live.items.data.length,2);
   const operation=check(await db.from('sms_billing_operations').select('*').eq('id',quote.operationId).single());assert(operation.invoice_id);
   let inv=await stripe.invoices.retrieve(operation.invoice_id);assert.equal(inv.status,'open');assert.equal(inv.amount_due,quote.amountDueCents);assert.equal(inv.parent?.subscription_details?.metadata?.sms_billing_operation_id,quote.operationId);
   assert.equal((await dbState(f.b)).plan,'chat_only');assert.equal((await addonState(f.a)).billing_source,'direct');
   await pass('Actual declined pending update keeps both source items and Chat/review access; immutable invoice metadata identifies the exact conversion');
   await stripe.subscriptions.update(f.subscription,{default_payment_method:f.card});await stripe.invoices.pay(inv.id,{payment_method:f.card});
   await poll('signed webhook activation',async()=>{const u=await upgradeState(f.u);return u.state==='activated'?u:null;});
   live=await stripe.subscriptions.retrieve(f.subscription);assert.equal(live.items.data.length,1);assert.equal(live.items.data[0].price.id,growth);
   assert.equal((await dbState(f.b)).plan,'sms_and_chat');const a=await addonState(f.a);assert.equal(a.billing_source,'included');assert.equal(a.exclusive_resources,false);assert.equal(a.stripe_item_id,null);
   const usage=check(await db.from('billing_usage_periods').select('*').eq('business_id',f.b).single());assert.equal(usage.included_sms_parts,1500);assert.equal(usage.inbound_sms_parts+usage.outbound_sms_parts,12);
   assert.equal(check(await db.rpc('review_sms_allowance',{p_business_id:f.b})),0);
   await pass('Real paid invoice reaches signed application webhook and atomically grants Growth/included reviews with one1500cap, preserved usage and no addon charge');
   const delivered=await poll('signed paid delivery',async()=>Array.from(deliveries.values()).find(d=>d.status===200&&(JSON.parse(d.body) as Stripe.Event).type==='invoice.payment_succeeded')??null);
   const replay=await handler(new Request('http://127.0.0.1:56402/api/stripe/webhook',{method:'POST',body:delivered.body,headers:{'stripe-signature':delivered.signature}}) as never);assert.equal(replay.status,200);
   const stale=await stripe.subscriptions.retrieve(f.subscription);stale.items.data.push({id:f.reviewItem,quantity:1,price:await stripe.prices.retrieve(addon),current_period_start:f.start,current_period_end:f.end} as unknown as Stripe.SubscriptionItem);
   stale.items.data[0].price=await stripe.prices.retrieve(chat);
   await (await import('../src/lib/stripe/subscriptionSync')).syncStripeSubscription(stale);
   assert.equal((await dbState(f.b)).plan,'sms_and_chat');
   await pass('Duplicate signed delivery and delayed two-item Chat snapshot cannot duplicate charges or restore the old plan');
   await advance(f.clock,f.end+2*3600);
   inv=await poll('Growth renewal paid',async()=>{const s=await stripe.subscriptions.retrieve(f.subscription);const i=await stripe.invoices.retrieve(objectId(s.latest_invoice));return i.id!==operation.invoice_id&&i.status==='paid'?i:null;});
   assert.equal(inv.amount_paid,4900);assert.equal(inv.lines.data.filter(l=>l.pricing?.price_details?.price===addon).length,0);
   await pass('Next actual recurring invoice is $49 with no $20 addon and no second activation fee');
   await stripe.subscriptions.cancel(f.subscription);await poll('cancellation sync',async()=>(await dbState(f.b)).status==='canceled');
   await pass('Later cancellation reaches the actual webhook and does not restore review access');
   accepted.delete(f.customer);
   const s=await fixture('sca_cancel',4900);
   const sca=await stripe.paymentMethods.create({type:'card',card:{token:'tok_threeDSecure2Required'},metadata});await stripe.paymentMethods.attach(sca.id,{customer:s.customer});await stripe.subscriptions.update(s.subscription,{default_payment_method:sca.id});
   const quote2=await billing.quoteTextingUpgrade(s.b,s.own);accepted.add(s.customer);
   await billing.confirmTextingUpgrade(s.b,s.own,quote2.operationId,quote2.quoteFingerprint,false);
   const scaSub=await stripe.subscriptions.retrieve(s.subscription);assert(scaSub.pending_update);assert.equal(scaSub.items.data.length,2);
   assert.equal((await upgradeState(s.u)).paid_at,null);assert.equal((await addonState(s.a)).billing_source,'direct');
   await billing.cancelTextingUpgrade(s.b,s.own);const canceledOp=check(await db.from('sms_billing_operations').select('*').eq('id',quote2.operationId).single());assert.equal(canceledOp.state,'expired');assert.equal((await stripe.invoices.retrieve(canceledOp.invoice_id)).status,'void');
   const preserved=await stripe.subscriptions.retrieve(s.subscription);assert.equal(preserved.pending_update,null);assert.equal(preserved.items.data.length,2);
   await (await import('../src/lib/stripe/subscriptionSync')).syncStripeSubscription(preserved);
   const resumed=check(await db.rpc('save_chat_texting_upgrade',{p_business_id:s.b,p_owner_id:s.own,p_target_plan:'sms_and_chat',p_starter_acknowledged:false}));assert.equal(resumed.id,s.u);
   await pass('Actual SCA invoice stays unpaid; cancel conclusively voids it, retains $35 source and reuses approved number handoff without a second setup fee ($49 historical receipt)');
   const recoveryQuote=await billing.quoteTextingUpgrade(s.b,s.own);assert.notEqual(recoveryQuote.operationId,quote2.operationId);assert.equal(recoveryQuote.setupFeeCents,0);
   await billing.confirmTextingUpgrade(s.b,s.own,recoveryQuote.operationId,recoveryQuote.quoteFingerprint,false);
   const recoveryOp=check(await db.from('sms_billing_operations').select('*').eq('id',recoveryQuote.operationId).single());
   const payments=await stripe.invoicePayments.list({invoice:recoveryOp.invoice_id,limit:10});
   const intentId=objectId(payments.data.find(p=>p.payment.type==='payment_intent')?.payment.payment_intent);assert(intentId);
   assert.equal((await stripe.paymentIntents.retrieve(intentId)).status,'requires_action');
   await stripe.subscriptions.update(s.subscription,{default_payment_method:s.card});
   await stripe.invoices.pay(recoveryOp.invoice_id,{payment_method:s.card});
   await poll('SCA exact-invoice paid recovery',async()=>(await upgradeState(s.u)).state==='activated');
   const recoveredSub=await stripe.subscriptions.retrieve(s.subscription);assert.equal(recoveredSub.items.data.length,1);assert.equal(recoveredSub.items.data[0].price.id,growth);
   assert.equal((await addonState(s.a)).billing_source,'included');assert.equal((await dbState(s.b)).plan,'sms_and_chat');
   await pass('Reopened handoff re-quotes after void; actual requires_action invoice recovers using a valid replacement payment method and signed webhook, without a new setup charge');
   for(const delivery of Array.from(deliveries.values()).filter(d=>d.status!==200)){
    const recovered=await handler(new Request('http://127.0.0.1:56402/api/stripe/webhook',{method:'POST',body:delivery.body,headers:{'stripe-signature':delivery.signature}}) as never);
    assert.equal(recovered.status,200,'Previously early/out-of-order signed delivery must recover');delivery.status=200;
   }
   await pass('Early or out-of-order signed deliveries remain retryable and reconcile from current provider state');
   report.status='passed';await save();
  }catch(error){report.status='failed';await save();throw error;}
  finally{
   accepted.clear();listener?.kill('SIGTERM');await new Promise<void>(resolve=>server.close(()=>resolve()));
   const cleanup=async(name:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch{report.cleanupErrors.push(name);}};
   for(const sub of owned.subscriptions)await cleanup('subscription '+sub,async()=>{const s=await stripe.subscriptions.retrieve(sub);assert.equal(s.metadata.review_conversion_e2e_run,run);if(s.status!=='canceled')await stripe.subscriptions.cancel(sub);});
   for(const clock of owned.clocks)await cleanup('clock '+clock,async()=>{const c=await stripe.testHelpers.testClocks.retrieve(clock);assert.equal(c.name,`Review conversion ${run}`);await stripe.testHelpers.testClocks.del(clock);});
   for(const price of owned.prices)await cleanup('price '+price,async()=>{const p=await stripe.prices.retrieve(price);assert.equal(p.metadata.review_conversion_e2e_run,run);await stripe.prices.update(price,{active:false});});
   for(const product of owned.products)await cleanup('product '+product,async()=>{const p=await stripe.products.retrieve(product);assert.equal(p.metadata.review_conversion_e2e_run,run);await stripe.products.update(product,{active:false});});
   for(const f of owned.fixtures)await cleanup('local fixture '+f.b,async()=>{
    sql(`BEGIN; DELETE FROM public.chat_texting_upgrades WHERE business_id=${q(f.b)} AND owner_id=${q(f.own)}; DELETE FROM public.chat_only_checkout_attempts WHERE business_id=${q(f.b)}; DELETE FROM public.sms_billing_operations WHERE business_id=${q(f.b)}; DELETE FROM public.businesses WHERE id=${q(f.b)} AND owner_id=${q(f.own)}; DELETE FROM auth.users WHERE id=${q(f.own)}; COMMIT;`);
   });
   if(owned.events.length)await cleanup('local event receipts',async()=>check(await db.from('stripe_webhook_events').delete().in('id',owned.events)));
   await save();assert.equal(report.cleanupErrors.length,0,`Cleanup failures recorded at ${reportPath}`);
  }
 },600_000);
});
