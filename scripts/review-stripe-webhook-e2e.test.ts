/**
 * Opt-in integration test: real Stripe TEST resources, hosted Checkout, Stripe
 * CLI-signed delivery, the actual application webhook, and local Supabase.
 *
 * Never reads .env. Supply REVIEW_STRIPE_E2E=1, STRIPE_SECRET_KEY=sk_test_...,
 * REVIEW_STRIPE_E2E_SUPABASE_URL, REVIEW_STRIPE_E2E_SERVICE_ROLE_KEY.
 * Set REVIEW_STRIPE_WEBHOOK_E2E=1 and
 * REVIEW_STRIPE_E2E_DATABASE_CONTAINER=supabase_db_SimplAssistReviews.
 * The isolated review stack must have the current migrations and no businesses.
 * Complete the Checkout URL written to the private checkout file with Stripe's
 * test card. No provider registration or customer messages are performed.
 * Run with vitest run scripts/review-stripe-webhook-e2e.test.ts.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { describe, it, vi } from "vitest";
import {
  validateConfiguration,
  assertTestObject,
} from "./review-stripe-release-e2e.mjs";

vi.mock("server-only", () => ({}));
// Imports of the webhook's unrelated base-plan launch path must never contact
// Telnyx. Throwing stubs make an accidental provider action fail this test.
vi.mock("@/lib/messaging/client", () => ({
  telnyx: new Proxy(
    {},
    {
      get: () => {
        throw new Error(
          "Provider actions are forbidden in billing integration tests",
        );
      },
    },
  ),
  TELNYX_MESSAGING_PROFILE_ID: "test-forbidden-profile",
  TELNYX_CONNECTION_ID: "test-forbidden-connection",
}));

const enabled = process.env.REVIEW_STRIPE_WEBHOOK_E2E === "1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const objectId = (value: unknown): string =>
  typeof value === "string" ? value : (value as { id: string }).id;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

describe.skipIf(!enabled)(
  "real review billing webhook and local entitlement integration",
  () => {
    it(
      "completes hosted activation and checks signed delivery, retries, paid access, and cancellation",
      async () => {
        const config = validateConfiguration(process.env);
        const fixtureContainer =
          process.env.REVIEW_STRIPE_E2E_DATABASE_CONTAINER;
        assert.equal(fixtureContainer, "supabase_db_SimplAssistReviews");
        for (const name of [
          "DOCKER_HOST",
          "DOCKER_CONTEXT",
          "DOCKER_TLS",
          "DOCKER_TLS_VERIFY",
        ])
          assert(
            !process.env[name],
            "Docker endpoint overrides are not accepted",
          );
        const context = spawnSync("docker", ["context", "inspect"], {
          encoding: "utf8",
        });
        assert.equal(context.status, 0);
        const dockerEndpoint: string = JSON.parse(context.stdout)[0].Endpoints
          .docker.Host;
        assert(
          dockerEndpoint.startsWith("unix:///"),
          "Only a local Docker Unix socket is accepted",
        );
        const inspection = spawnSync(
          "docker",
          ["--host", dockerEndpoint, "inspect", fixtureContainer],
          { encoding: "utf8" },
        );
        assert.equal(
          inspection.status,
          0,
          "Disposable database inspection must succeed",
        );
        const container = JSON.parse(inspection.stdout)[0];
        assert.equal(
          container.Config.Labels["com.supabase.cli.project"],
          "SimplAssistReviews",
        );
        assert.equal(
          container.HostConfig.PortBindings["5432/tcp"][0].HostPort,
          String(Number(new URL(config.localUrl).port) + 1),
        );
        const run = randomUUID();
        const business = randomUUID(),
          owner = randomUUID(),
          account = randomUUID(),
          operation = randomUUID();
        const reportPath =
          process.env.REVIEW_STRIPE_E2E_REPORT ??
          "/private/tmp/review-stripe-webhook-e2e.json";
        const checkoutPath =
          process.env.REVIEW_STRIPE_E2E_CHECKOUT ??
          "/private/tmp/review-stripe-webhook-checkout.json";
        const stripe = new Stripe(config.key, {
          apiVersion: "2026-02-25.clover",
          maxNetworkRetries: 2,
        });
        const db = createClient(config.localUrl, config.localKey, {
          auth: { persistSession: false },
        });
        const report: {
          run: string;
          status: string;
          checks: string[];
          cleanupErrors: string[];
          limitation: string;
          resources?: Record<string, string[]>;
          error?: string;
        } = {
          run,
          status: "running",
          checks: [],
          cleanupErrors: [],
          limitation:
            "Carrier approval is a local fixture; no Telnyx calls. Hosted activation uses a fixture-bound Checkout; recurring quote, confirmation, cancellation and all webhook/entitlement logic are actual application code.",
        };
        const save = () =>
          writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
            mode: 0o600,
          });
        const pass = async (name: string) => {
          report.checks.push(name);
          console.log(`PASS: ${name}`);
          await save();
        };
        const owned = {
          products: [] as string[],
          prices: [] as string[],
          customers: [] as string[],
          subscriptions: [] as string[],
          checkouts: [] as string[],
          events: [] as string[],
        };
        report.resources = owned;
        const metadata = { review_stripe_e2e_run: run, business_id: business };
        const check = <T>(result: {
          data: T;
          error: { message: string } | null;
        }): T => {
          assert.equal(result.error, null, result.error?.message);
          return result.data;
        };
        const poll = async <T>(
          name: string,
          read: () => Promise<T | null | false>,
          ms = 60_000,
        ): Promise<T> => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            const value = await read();
            if (value) return value;
            await sleep(1000);
          }
          throw new Error(`Timed out: ${name}`);
        };
        const state = async () =>
          check(
            await db
              .from("review_sms_accounts")
              .select("*")
              .eq("id", account)
              .single(),
          );
        const access = async () =>
          check(
            await db.rpc("has_review_sms_access", { p_business_id: business }),
          );
        const requests = new Map<
          string,
          { body: string; signature: string; response: unknown; status: number }
        >();
        let handler:
          | typeof import("../src/app/api/stripe/webhook/route").POST
          | undefined;
        let webhookSecret = "",
          listener: ReturnType<typeof spawn> | undefined;
        let customerId = "",
          accept = false;
        const server = createServer(async (req, res) => {
          if (req.url === "/success") {
            res.end("Stripe test payment complete. You can close this tab.");
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString();
          try {
            const event = JSON.parse(body) as Stripe.Event;
            const obj = event.data.object as unknown as {
              customer?: string;
              metadata?: Record<string, string>;
            };
            if (
              !accept ||
              !handler ||
              !(
                obj.metadata?.business_id === business ||
                obj.customer === customerId
              )
            ) {
              res.end("ignored");
              return;
            }
            assert.equal(event.livemode, false);
            const signature = String(req.headers["stripe-signature"] ?? "");
            const result = await handler(
              new Request("http://127.0.0.1:56401/api/stripe/webhook", {
                method: "POST",
                body,
                headers: { "stripe-signature": signature },
              }) as never,
            );
            const response = await result.json();
            requests.set(event.id, {
              body,
              signature,
              status: result.status,
              response,
            });
            if (!owned.events.includes(event.id)) owned.events.push(event.id);
            res.writeHead(result.status, {
              "content-type": "application/json",
            });
            res.end(JSON.stringify(response));
          } catch (error) {
            res.writeHead(500);
            res.end(String(error));
          }
        });
        try {
          await save();
          assertTestObject(await stripe.balance.retrieve());
          // Require the empty, disposable review stack. Never reset a populated DB.
          assert.equal(
            (check(await db.from("businesses").select("id")) ?? []).length,
            0,
            "Disposable local DB must start without businesses",
          );
          await pass("Stripe TEST mode and empty loopback database verified");
          const product = assertTestObject(
            await stripe.products.create({
              name: `Webhook review test ${run}`,
              metadata,
            }),
          );
          owned.products.push(product.id);
          const price = async (amount: number, recurring: boolean) => {
            const p = assertTestObject(
              await stripe.prices.create({
                product: product.id,
                unit_amount: amount,
                currency: "usd",
                metadata,
                ...(recurring
                  ? { recurring: { interval: "month" as const } }
                  : {}),
              }),
            );
            owned.prices.push(p.id);
            await save();
            return p.id;
          };
          const basePrice = await price(1500, true),
            addonPrice = await price(2000, true),
            activationPrice = await price(4900, false);
          const starterPrice = await price(2900, true),
            growthPrice = await price(4900, true),
            proPrice = await price(7900, true);
          Object.assign(process.env, {
            NEXT_PUBLIC_SUPABASE_URL: config.localUrl,
            SUPABASE_SERVICE_ROLE_KEY: config.localKey,
            STRIPE_PRICE_CHAT_ONLY: basePrice,
            STRIPE_PRICE_REVIEW_SMS: addonPrice,
            STRIPE_PRICE_REVIEW_SMS_ACTIVATION: activationPrice,
            STRIPE_PRICE_SMS_ONLY: starterPrice,
            STRIPE_PRICE_SMS_AND_CHAT: growthPrice,
            STRIPE_PRICE_FULL: proPrice,
            NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED: "1",
            REVIEWS_SMS_ENABLED: "1",
            REVIEWS_SMS_PILOT_BUSINESS_IDS: business,
            REVIEWS_SMS_PROVISIONING_ENABLED: "0",
            REVIEWS_SMS_SENDING_ENABLED: "0",
            REVIEWS_EMAIL_SENDING_ENABLED: "0",
            RESEND_API_KEY: "re_forbidden_test",
            ANTHROPIC_API_KEY: "forbidden-test",
            NEXT_PUBLIC_APP_URL: "http://127.0.0.1:56401",
          });
          await new Promise<void>((resolve) =>
            server.listen(56401, "127.0.0.1", resolve),
          );
          listener = spawn(
            "stripe",
            [
              "listen",
              "--api-key",
              config.key,
              "--events",
              "checkout.session.completed,checkout.session.expired,customer.subscription.updated,customer.subscription.deleted,invoice.payment_succeeded,invoice.payment_failed",
              "--forward-to",
              "http://127.0.0.1:56401/api/stripe/webhook",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          const capture = (chunk: Buffer) => {
            const match = chunk.toString().match(/whsec_[A-Za-z0-9]+/);
            if (match) webhookSecret = match[0];
          };
          listener.stdout?.on("data", capture);
          listener.stderr?.on("data", capture);
          await poll(
            "Stripe CLI signing secret",
            async () => webhookSecret || null,
          );
          process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
          handler = (await import("../src/app/api/stripe/webhook/route")).POST;
          const billing = await import("../src/lib/stripe/reviewSms.server");
          const createdUser = await db.auth.admin.createUser({
            id: owner,
            email: `review-webhook-${run}@example.invalid`,
            email_confirm: true,
          });
          assert.equal(createdUser.error, null);
          assert.equal(createdUser.data.user?.id, owner);
          check(
            await db.from("businesses").insert({
              id: business,
              owner_id: owner,
              name: "Disposable review webhook test",
              business_type: "general",
              onboarding_selected_plan: "chat_only",
              slug: `review-webhook-${run}`,
            }),
          );
          const customer = assertTestObject(
            await stripe.customers.create({
              email: `review-webhook-${run}@example.invalid`,
              metadata,
            }),
          );
          customerId = customer.id;
          owned.customers.push(customer.id);
          const pm = await stripe.paymentMethods.create({
            type: "card",
            card: { token: "tok_visa" },
            metadata,
          });
          await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
          const fingerprint = "a".repeat(64);
          const attemptRow = check(
            await db.rpc("acquire_chat_only_checkout_attempt", {
              p_business_id: business,
              p_stripe_price_id: basePrice,
              p_request_fingerprint: fingerprint,
              p_claim_token: randomUUID(),
            }),
          );
          assert.equal(attemptRow.status, "create");
          const attempt = attemptRow.attempt_id,
            expiry = new Date(
              attemptRow.checkout_session_expires_at,
            ).toISOString();
          const subscription = assertTestObject(
            await stripe.subscriptions.create({
              customer: customer.id,
              default_payment_method: pm.id,
              items: [{ price: basePrice }],
              payment_behavior: "error_if_incomplete",
              metadata: {
                ...metadata,
                plan: "chat_only",
                mode: "onboarding",
                checkout_attempt_id: attempt,
                checkout_request_fingerprint: fingerprint,
                checkout_session_expires_at: expiry,
              },
            }),
          );
          owned.subscriptions.push(subscription.id);
          const { syncStripeSubscription } = await import(
            "../src/lib/stripe/subscriptionSync"
          );
          await syncStripeSubscription(subscription);
          check(
            await db.from("review_sms_accounts").insert({
              id: account,
              business_id: business,
              owner_id: owner,
              billing_source: "direct",
              source_subscription_id: subscription.id,
              source_customer_id: customer.id,
              state: "activation_pending",
              exclusive_resources: true,
            }),
          );
          check(
            await db.from("review_sms_billing_operations").insert({
              id: operation,
              account_id: account,
              business_id: business,
              owner_id: owner,
              kind: "activation",
              state: "confirmed",
              fingerprint,
              payload: {
                customerId: customer.id,
                subscriptionId: subscription.id,
              },
            }),
          );
          const activationMetadata = {
            ...metadata,
            review_sms_account_id: account,
            review_sms_operation_id: operation,
          };
          const checkout = assertTestObject(
            await stripe.checkout.sessions.create({
              mode: "payment",
              customer: customer.id,
              client_reference_id: business,
              line_items: [{ price: activationPrice, quantity: 1 }],
              payment_method_types: ["card"],
              metadata: activationMetadata,
              payment_intent_data: { metadata: activationMetadata },
              success_url: "http://127.0.0.1:56401/success",
              cancel_url: "http://127.0.0.1:56401/success",
            }),
          );
          owned.checkouts.push(checkout.id);
          check(
            await db
              .from("review_sms_billing_operations")
              .update({ checkout_session_id: checkout.id })
              .eq("id", operation),
          );
          accept = true;
          await writeFile(
            checkoutPath,
            JSON.stringify(
              {
                run,
                url: checkout.url,
                amount: 4900,
                currency: "usd",
                testOnly: true,
              },
              null,
              2,
            ) + "\n",
            { mode: 0o600 },
          );
          await save();
          console.log(`HOSTED CHECKOUT READY: ${checkoutPath}`);
          await poll(
            "hosted Checkout completion and signed webhook activation",
            async () => (await state()).activation_paid_at || null,
            20 * 60_000,
          );
          assert.equal((await state()).state, "carrier_pending");
          assert.equal(await access(), false);
          const delivered = Array.from(requests.entries()).find(
            ([, v]) => JSON.parse(v.body).type === "checkout.session.completed",
          );
          assert(delivered);
          assert.equal(delivered[1].status, 200);
          await pass(
            "Real hosted $49 TEST Checkout reached the actual signed application webhook and local activation ledger",
          );
          const before = await state();
          const replay = await handler(
            new Request("http://127.0.0.1:56401/api/stripe/webhook", {
              method: "POST",
              body: delivered[1].body,
              headers: { "stripe-signature": delivered[1].signature },
            }) as never,
          );
          assert.equal(replay.status, 200);
          assert.equal((await replay.json()).duplicate, true);
          assert.equal(
            (await state()).activation_paid_at,
            before.activation_paid_at,
          );
          await pass(
            "Duplicate signed Checkout delivery preserves one activation and does not grant sending",
          );
          const signatureLog = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
          const bad = await handler(
            new Request("http://127.0.0.1:56401/api/stripe/webhook", {
              method: "POST",
              body: delivered[1].body,
              headers: { "stripe-signature": "invalid" },
            }) as never,
          );
          signatureLog.mockRestore();
          assert.equal(bad.status, 400);
          await pass(
            "Invalid webhook signature is rejected before entitlement mutation",
          );
          // Synthetic carrier approval is intentionally local. This suite validates
          // billing authority, not carrier review or a real sending identity.
          const phone = randomUUID();
          const approval = new Date().toISOString();
          check(
            await db
              .from("businesses")
              .update({
                telnyx_campaign_id: "e2e-local-campaign",
                telnyx_messaging_profile_id: "e2e-local-profile",
                campaign_status: "approved",
              })
              .eq("id", business),
          );
          check(
            await db.from("phone_numbers").insert({
              id: phone,
              business_id: business,
              phone_number: "+15555550998",
              telnyx_phone_number_id: "e2e-local-phone",
              is_active: true,
              resource_status: "active",
              telnyx_campaign_assignment_status: "assigned",
              telnyx_campaign_assignment_campaign_id: "e2e-local-campaign",
            }),
          );
          check(
            await db
              .from("review_sms_accounts")
              .update({
                state: "ready_unpaid",
                campaign_id: "e2e-local-campaign",
                messaging_profile_id: "e2e-local-profile",
                phone_number_id: phone,
                review_usecase_approved_at: approval,
                approval_evidence: "Local test fixture only",
                ready_at: approval,
                ready_expires_at: expiry,
                provider_started_at: approval,
              })
              .eq("id", account),
          );
          assert.equal(
            check(
              await db.rpc("review_sms_owns_plan_family_resources", {
                p_business: business,
              }),
            ),
            true,
          );
          const declineCard = assertTestObject(
            await stripe.paymentMethods.create({
              type: "card",
              card: { token: "tok_chargeCustomerFail" },
              metadata,
            }),
          );
          await stripe.paymentMethods.attach(declineCard.id, {
            customer: customer.id,
          });
          await stripe.subscriptions.update(subscription.id, {
            default_payment_method: declineCard.id,
          });
          const quote = await billing.quoteReviewSmsRecurring(business, owner);
          assert(quote.amountDueCents > 0 && quote.amountDueCents <= 2000);
          const pending = await billing.confirmReviewSmsRecurring(
            business,
            owner,
            quote.operationId,
            quote.fingerprint,
          );
          assert.equal(pending.active, false);
          assert.equal(await access(), false);
          const unpaid = assertTestObject(
            await stripe.subscriptions.retrieve(subscription.id),
          );
          assert(unpaid.pending_update);
          assert.equal(unpaid.items.data.length, 1);
          const duplicateConfirmation = await billing.confirmReviewSmsRecurring(
            business,
            owner,
            quote.operationId,
            quote.fingerprint,
          );
          assert.equal(duplicateConfirmation.active, false);
          assert.equal(
            objectId(
              (await stripe.subscriptions.retrieve(subscription.id))
                .latest_invoice,
            ),
            objectId(unpaid.latest_invoice),
          );
          await poll(
            "signed invoice failure webhook",
            async () =>
              Array.from(requests.values()).find(
                (v) =>
                  JSON.parse(v.body).type === "invoice.payment_failed" &&
                  v.status === 200,
              ) ?? null,
          );
          await pass(
            "Declined add-on and duplicate confirmation leave one unpaid invoice and no sending access; signed failure webhook succeeds",
          );
          await stripe.subscriptions.update(subscription.id, {
            default_payment_method: pm.id,
          });
          const recoveredInvoice = assertTestObject(
            await stripe.invoices.pay(objectId(unpaid.latest_invoice), {
              payment_method: pm.id,
            }),
          );
          assert.equal(recoveredInvoice.status, "paid");
          await poll("signed paid invoice recovery", async () =>
            (await access()) ? true : null,
          );
          await pass(
            "Paying the exact failed invoice recovers access through the actual signed webhook",
          );
          const active = await state();
          assert(active.paid_invoice_id);
          assert(active.period_allowance > 0 && active.period_allowance <= 250);
          await pass(
            "Actual recurring quote/confirmation charges only Chat's $20 add-on and records bounded paid access",
          );
          await poll(
            "signed recurring webhook",
            async () =>
              Array.from(requests.values()).find(
                (v) =>
                  JSON.parse(v.body).type === "customer.subscription.updated" &&
                  v.status === 200,
              ) ?? null,
          );
          await pass(
            "Real recurring subscription update reaches signed webhook and keeps paid access",
          );
          // Deliver an old provider snapshot under a fresh test signature: arrival
          // order must re-read Stripe, never restore stale unpaid addon state.
          const stale = {
            id: `evt_e2e_stale_${run.replaceAll("-", "")}`,
            object: "event",
            type: "customer.subscription.updated",
            livemode: false,
            data: { object: subscription },
            created: Math.floor(Date.now() / 1000) - 60,
          };
          const staleBody = JSON.stringify(stale);
          owned.events.push(stale.id);
          const staleResult = await handler(
            new Request("http://127.0.0.1:56401/api/stripe/webhook", {
              method: "POST",
              body: staleBody,
              headers: {
                "stripe-signature": stripe.webhooks.generateTestHeaderString({
                  payload: staleBody,
                  secret: webhookSecret,
                }),
              },
            }) as never,
          );
          assert.equal(staleResult.status, 200);
          assert.equal(await access(), true);
          assert.equal((await state()).paid_invoice_id, active.paid_invoice_id);
          await pass(
            "Delayed provider snapshot replay cannot remove the verified current review paid period (test-signed replay)",
          );
          const cancel = await billing.cancelReviewSmsAtPeriodEnd(
            business,
            owner,
          );
          assert.equal((await state()).state, "cancel_pending");
          assert.equal(await access(), true);
          assert(cancel.cancelAt);
          await pass(
            "Actual period-end cancellation preserves paid access until the scheduled end",
          );
          // Exercise the database deadline without waiting a month or forwarding
          // future test-clock timestamps into today's database clock.
          check(
            await db
              .from("review_sms_accounts")
              .update({ cancel_at: iso(Math.floor(Date.now() / 1000) - 1) })
              .eq("id", account),
          );
          assert.equal(await access(), false);
          await pass(
            "Expired cancellation deadline denies sending even without a final webhook",
          );
          // Further mutations are explicit local entitlement fixtures. Stop
          // forwarding events before those fixtures diverge from Stripe.
          accept = false;
          await sleep(300);
          check(
            await db
              .from("review_sms_accounts")
              .update({
                state: "active",
                billing_source: "included",
                cancel_at: null,
              })
              .eq("id", account),
          );
          for (const plan of ["sms_only", "sms_and_chat", "full"]) {
            check(
              await db
                .from("subscriptions")
                .update({ plan })
                .eq("business_id", business),
            );
            assert.equal(await access(), true);
            const overview = await billing.reviewSmsOverview(business, owner);
            assert.equal(overview.price.monthlyCents, 0);
            assert.equal(overview.price.activationCents, 0);
            assert.equal(
              check(
                await db.rpc("review_sms_allowance", {
                  p_business_id: business,
                }),
              ),
              0,
            );
          }
          await pass(
            "All higher plans include reviews without another $20 or activation fee and share their existing SMS pool",
          );
          check(
            await db
              .from("subscriptions")
              .update({ plan: "chat_only" })
              .eq("business_id", business),
          );
          check(
            await db
              .from("review_sms_accounts")
              .update({
                billing_source: "grant",
                grant_actor: owner,
                grant_expires_at: expiry,
              })
              .eq("id", account),
          );
          assert.equal(await access(), true);
          check(
            await db
              .from("review_sms_accounts")
              .update({
                grant_expires_at: iso(Math.floor(Date.now() / 1000) - 1),
              })
              .eq("id", account),
          );
          assert.equal(await access(), false);
          await pass(
            "Time-limited local review grant expires and cannot retain access",
          );
          report.status = "passed";
        } catch (error) {
          report.status = "failed";
          report.error = String(error);
          throw error;
        } finally {
          accept = false;
          listener?.kill("SIGTERM");
          await new Promise<void>((resolve) => server.close(() => resolve()));
          const cleanup = async (
            label: string,
            work: () => Promise<unknown>,
          ) => {
            try {
              await work();
            } catch (error) {
              report.cleanupErrors.push(`${label}: ${String(error)}`);
            }
          };
          for (const id of owned.subscriptions)
            await cleanup("subscription", async () => {
              const sub = assertTestObject(
                await stripe.subscriptions.retrieve(id),
              );
              assert.equal(sub.metadata.review_stripe_e2e_run, run);
              if (sub.status !== "canceled")
                await stripe.subscriptions.cancel(id);
            });
          for (const id of owned.checkouts)
            await cleanup("checkout", async () => {
              const session = assertTestObject(
                await stripe.checkout.sessions.retrieve(id),
              );
              if (session.status === "open")
                await stripe.checkout.sessions.expire(id);
            });
          for (const id of owned.customers)
            await cleanup("customer", async () => {
              const customer = await stripe.customers.retrieve(id);
              assert(!customer.deleted);
              assert.equal(customer.metadata.review_stripe_e2e_run, run);
              await stripe.customers.del(id);
            });
          for (const id of owned.prices)
            await cleanup("price", () =>
              stripe.prices.update(id, { active: false }),
            );
          for (const id of owned.products)
            await cleanup("product", () =>
              stripe.products.update(id, { active: false }),
            );
          await cleanup("local protected fixture ledger", async () => {
            // The production service role deliberately cannot erase Checkout
            // authority. PostgreSQL fixture cleanup is confined to the verified
            // local container and this generated run's business and owner.
            const result = spawnSync(
              "docker",
              [
                "--host",
                dockerEndpoint,
                "exec",
                fixtureContainer,
                "psql",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                `DELETE FROM public.chat_only_checkout_attempts WHERE business_id='${business}' AND EXISTS(SELECT 1 FROM public.businesses WHERE id='${business}' AND owner_id='${owner}' AND slug='review-webhook-${run}');`,
              ],
              { encoding: "utf8" },
            );
            assert.equal(
              result.status,
              0,
              "Local fixture ledger cleanup failed",
            );
          });
          await cleanup("local business", async () =>
            check(
              await db
                .from("businesses")
                .delete()
                .eq("id", business)
                .eq("owner_id", owner),
            ),
          );
          await cleanup("local owner", async () =>
            assert.equal((await db.auth.admin.deleteUser(owner)).error, null),
          );
          if (owned.events.length)
            await cleanup("local events", async () =>
              check(
                await db
                  .from("stripe_webhook_events")
                  .delete()
                  .in("id", owned.events),
              ),
            );
          await save();
          assert.equal(
            report.cleanupErrors.length,
            0,
            "Disposable test resources must be cleaned up",
          );
        }
      },
      30 * 60_000,
    );
  },
);
