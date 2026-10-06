import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as Array<{ current: unknown }>, cursor: 0, refCursor: 0 }));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.states)) hooks.states[i] = initial;
    return [hooks.states[i], (next: unknown) => { hooks.states[i] = next; }];
  },
  useRef: (initial: unknown) => {
    const i = hooks.refCursor++;
    return hooks.refs[i] ?? (hooks.refs[i] = { current: initial });
  },
}));
import { ReviewCampaignRetryPanel } from "./ReviewCampaignRetryPanel";

const businessId = "10000000-0000-4000-8000-000000000001";
const inspection = {
  eligible: true, reason: null,
  businessId,
  ownerId: "20000000-0000-4000-8000-000000000001",
  accountId: "30000000-0000-4000-8000-000000000001",
  originalReservationId: "40000000-0000-4000-8000-000000000001",
  originalPayloadHash: "a".repeat(64), membershipRevision: 2, state: "carrier_pending",
  providerMatchCount: 0,
  attempts: [{ id: "50000000-0000-4000-8000-000000000001", referenceId: "reviews:original", state: "unknown",
    startedAt: "2026-10-06T03:12:21.969Z", diagnostics: { rawPayload: "PRIVATE PROVIDER INFORMATION" } }],
};
const authorization = {
  attemptId: "60000000-0000-4000-8000-000000000001", token: "private-one-use-token", expiresAt: "2099-10-06T03:12:21.969Z",
};
const preparedInspection = { ...inspection, eligible: false, reason: "The retry is already prepared.", attempts: [
  ...inspection.attempts, { id: authorization.attemptId, referenceId: "reviews:original:r1", state: "prepared", startedAt: null, diagnostics: null },
] };
const recoverableInspection = { ...preparedInspection, preparedRetry: { attemptId: authorization.attemptId, revision: 1 } };
const fetcher = vi.fn();
const response = (payload: unknown, ok = true) => ({ ok, json: async () => payload });
function render() {
  hooks.cursor = 0; hooks.refCursor = 0;
  return ReviewCampaignRetryPanel({ businessId });
}
type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (predicate(node)) return node;
  return find(node.props.children as ReactNode, predicate);
}
function button(label: string) {
  return find(render(), element => element.type === "button" && element.props.children === label);
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function click(label: string) {
  const item = button(label);
  expect(item).toBeDefined();
  expect(item!.props.disabled).toBe(false);
  (item!.props.onClick as () => void)();
  await settle();
}
function accept() {
  const input = find(render(), element => element.type === "input");
  expect(input!.props.disabled).toBe(false);
  (input!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0;
  fetcher.mockReset().mockResolvedValue(response({ inspection }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("one-use administrative campaign retry", () => {
  it("requires acknowledgement for one corrected application and never automatically repeats it", async () => {
    const corrected = { ...inspection, eligible: false, correctedEligible: true, reason: null };
    fetcher.mockResolvedValueOnce(response({ inspection: corrected }));
    await click("Inspect campaign status");
    expect(button("Submit corrected campaign once")!.props.disabled).toBe(true);
    expect(button("Retry campaign once")).toBeUndefined();
    accept();
    fetcher.mockResolvedValueOnce(response({ authorization }))
      .mockResolvedValueOnce(response({ inspection: { ...corrected, correctedEligible: false, reason: "used" } }));
    await click("Submit corrected campaign once");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ action: "prepare_corrected", businessId, acceptAdditionalFee: true });
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ action: "execute", businessId, attemptId: authorization.attemptId, token: authorization.token });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(button("Submit corrected campaign once")).toBeUndefined();
  });

  it("only inspects after losing a corrected submission response", async () => {
    const corrected = { ...inspection, eligible: false, correctedEligible: true };
    fetcher.mockResolvedValueOnce(response({ inspection: corrected }));
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization })).mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce(response({ inspection: { ...corrected, correctedEligible: false } }));
    await click("Submit corrected campaign once");
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(2);
    expect(fetcher.mock.calls[3][1]).toEqual({ cache: "no-store" });
    expect(button("Submit corrected campaign once")).toBeUndefined();
  });

  it("does nothing on render and explains duplicate risk, provider fee, and unchanged Stripe billing", () => {
    const html = renderToStaticMarkup(render());
    expect(fetcher).not.toHaveBeenCalled();
    expect(html).toContain("unknown outcome");
    expect(html).toContain("duplicate campaign and an additional Telnyx fee");
    expect(html).toContain("does not charge another Stripe activation fee");
    expect(button("Retry campaign once")).toBeUndefined();
  });

  it("inspects without mutation or automatically accepting another paid submission", async () => {
    await click("Inspect campaign status");
    expect(fetcher.mock.calls).toEqual([[`/api/admin/reviews/sms/campaign-retry?businessId=${businessId}`, { cache: "no-store" }]]);
    expect(button("Retry campaign once")!.props.disabled).toBe(true);
    const html = renderToStaticMarkup(render());
    expect(html).toContain("Attempt 1: unknown");
    expect(html).not.toContain("PRIVATE PROVIDER INFORMATION");
    expect(html).not.toContain(inspection.ownerId);
  });

  it("prepares exact inspected bindings and executes only the returned one-use authorization", async () => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization }))
      .mockResolvedValueOnce(response({ inspection: { ...inspection, eligible: false, state: "carrier_pending", reason: "retry_used" } }));
    await click("Retry campaign once");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      action: "prepare", businessId, ownerId: inspection.ownerId, accountId: inspection.accountId,
      originalReservationId: inspection.originalReservationId, originalPayloadHash: inspection.originalPayloadHash,
      membershipRevision: inspection.membershipRevision, acceptAdditionalFee: true,
    });
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ action: "execute", businessId,
      attemptId: authorization.attemptId, token: authorization.token });
    expect(button("Retry campaign once")).toBeUndefined();
    const html = renderToStaticMarkup(render());
    expect(html).toContain("carrier approval is still required");
    expect(html).not.toContain(authorization.token);
  });

  it("accepts PostgreSQL expiry timestamps with offset and microseconds and proceeds to execute", async () => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization: { ...authorization, expiresAt: "2099-10-06T03:12:21.123456+00:00" } }))
      .mockResolvedValueOnce(response({ inspection: { ...inspection, eligible: false, reason: "retry_used" } }));
    await click("Retry campaign once");
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => JSON.parse(options.body));
    expect(posts.map(post => post.action)).toEqual(["prepare", "execute"]);
    expect(posts[1]).toEqual({ action: "execute", businessId, attemptId: authorization.attemptId, token: authorization.token });
  });

  it("blocks double clicks before React can render the busy state", async () => {
    await click("Inspect campaign status"); accept();
    fetcher.mockImplementationOnce(() => new Promise(() => {}));
    const onClick = button("Retry campaign once")!.props.onClick as () => void;
    onClick(); onClick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(button("Inspect campaign status")!.props.disabled).toBe(true);
  });

  it.each(["prepare", "execute"])("refreshes only with GET after an unknown %s response; never replays the submission", async stage => {
    await click("Inspect campaign status"); accept();
    if (stage === "execute") fetcher.mockResolvedValueOnce(response({ authorization }));
    fetcher.mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(response({ inspection }));
    await click("Retry campaign once");
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(stage === "execute" ? 2 : 1);
    expect(fetcher.mock.calls.at(-1)).toEqual([`/api/admin/reviews/sms/campaign-retry?businessId=${businessId}`, { cache: "no-store" }]);
    expect(renderToStaticMarkup(render())).toContain("submission was not repeated");
    expect(button("Retry campaign once")).toBeUndefined();
    await click("Inspect campaign status");
    expect(button("Retry campaign once")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(posts.length);
  });

  it.each(["busy", "lost response"])("retains the prepared capability after %s and resumes only after explicit inspection and another click", async outcome => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization }));
    if (outcome === "busy") fetcher.mockResolvedValueOnce(response({ code: "review_sms_provisioning_busy" }, false));
    else fetcher.mockRejectedValueOnce(new Error("Connection lost"));
    fetcher.mockResolvedValue(response({ inspection: preparedInspection }));
    await click("Retry campaign once");
    expect(button("Retry campaign once")).toBeUndefined();
    expect(button("Resume prepared retry")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);

    await click("Inspect campaign status");
    expect(button("Resume prepared retry")!.props.disabled).toBe(false);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
    expect(renderToStaticMarkup(render())).not.toContain(authorization.token);
    fetcher.mockResolvedValueOnce(response({ inspection: { ...preparedInspection,
      attempts: preparedInspection.attempts.map(attempt => attempt.id === authorization.attemptId ? { ...attempt, state: "unknown" } : attempt),
    } }));
    await click("Resume prepared retry");
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => JSON.parse(options.body));
    expect(posts.map(post => post.action)).toEqual(["prepare", "execute", "execute"]);
    expect(posts[2]).toEqual(posts[1]);
    expect(button("Resume prepared retry")).toBeUndefined();
  });

  it.each(["submitting", "unknown", "accepted", "rejected"])("never resumes a capability consumed into %s, even after a lost response", async state => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization }))
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValue(response({ inspection: { ...preparedInspection,
        attempts: preparedInspection.attempts.map(attempt => attempt.id === authorization.attemptId ? { ...attempt, state } : attempt),
      } }));
    await click("Retry campaign once");
    await click("Inspect campaign status");
    expect(button("Resume prepared retry")).toBeUndefined();
    expect(button("Retry campaign once")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
  });

  it("does not resume an expired prepared token", async () => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization }))
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValue(response({ inspection: preparedInspection }));
    await click("Retry campaign once");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2100-01-01T00:00:00.000Z"));
    await click("Inspect campaign status");
    expect(button("Resume prepared retry")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
  });

  it("does not resume when the inspected account bindings changed", async () => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization }))
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(response({ inspection: preparedInspection }))
      .mockResolvedValue(response({ inspection: { ...preparedInspection, ownerId: inspection.accountId } }));
    await click("Retry campaign once");
    await click("Inspect campaign status");
    expect(button("Resume prepared retry")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
  });

  it("requires manual inspection and fee acknowledgement before recovering and executing the same unused attempt", async () => {
    fetcher.mockResolvedValue(response({ inspection: recoverableInspection }));
    render();
    expect(fetcher).not.toHaveBeenCalled();
    expect(button("Resume unused retry")).toBeUndefined();
    await click("Inspect campaign status");
    expect(button("Resume unused retry")!.props.disabled).toBe(true);
    expect(button("Retry campaign once")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    accept();
    fetcher.mockResolvedValueOnce(response({ authorization: { ...authorization, expiresAt: "2099-10-06T03:12:21.123456+00:00" } }))
      .mockResolvedValueOnce(response({ inspection: { ...recoverableInspection, preparedRetry: null,
        attempts: preparedInspection.attempts.map(attempt => attempt.id === authorization.attemptId ? { ...attempt, state: "unknown" } : attempt),
      } }));
    await click("Resume unused retry");
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => JSON.parse(options.body));
    expect(posts).toEqual([
      { action: "reauthorize", businessId, ownerId: inspection.ownerId, accountId: inspection.accountId,
        originalReservationId: inspection.originalReservationId, originalPayloadHash: inspection.originalPayloadHash,
        membershipRevision: inspection.membershipRevision, acceptAdditionalFee: true,
        attemptId: authorization.attemptId, authorizationRevision: 1 },
      { action: "execute", businessId, attemptId: authorization.attemptId, token: authorization.token },
    ]);
    expect(button("Resume unused retry")).toBeUndefined();
    expect(button("Resume prepared retry")).toBeUndefined();
    expect(renderToStaticMarkup(render())).not.toContain(authorization.token);
  });

  it("does not automatically reauthorize a capability lost during prepare even when automatic status refresh finds it", async () => {
    await click("Inspect campaign status"); accept();
    fetcher.mockRejectedValueOnce(new Error("Prepare response lost"))
      .mockResolvedValue(response({ inspection: recoverableInspection }));
    await click("Retry campaign once");
    expect(button("Resume unused retry")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    await click("Inspect campaign status");
    expect(button("Resume unused retry")!.props.disabled).toBe(true);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("refuses to execute a replacement capability returned for another attempt", async () => {
    fetcher.mockResolvedValue(response({ inspection: recoverableInspection }));
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization: { ...authorization, attemptId: inspection.accountId } }));
    await click("Resume unused retry");
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => JSON.parse(options.body));
    expect(posts.map(post => post.action)).toEqual(["reauthorize"]);
    expect(button("Resume unused retry")).toBeUndefined();
    expect(renderToStaticMarkup(render())).toContain("retry outcome is not confirmed");
  });

  it.each(["submitting", "unknown", "accepted", "rejected"])("offers no lost-token recovery once the attempt is %s", async state => {
    fetcher.mockResolvedValue(response({ inspection: { ...recoverableInspection, preparedRetry: null,
      attempts: preparedInspection.attempts.map(attempt => attempt.id === authorization.attemptId ? { ...attempt, state } : attempt),
    } }));
    await click("Inspect campaign status");
    expect(button("Resume unused retry")).toBeUndefined();
    expect(button("Retry campaign once")).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });

  it("stops after a stale reauthorization revision instead of executing or repeating it", async () => {
    fetcher.mockResolvedValue(response({ inspection: recoverableInspection }));
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ code: "review_sms_campaign_retry_changed" }, false));
    await click("Resume unused retry");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(button("Resume unused retry")).toBeUndefined();
  });

  it.each([
    { ...inspection, eligible: false, reason: "campaign_retry_unavailable" },
    { ...inspection, providerMatchCount: 1 },
    { ...inspection, ownerId: null },
    { ...inspection, originalReservationId: null },
    { ...inspection, accountId: null },
  ])("does not offer a paid retry without complete eligible ownership and absent provider matches", async value => {
    fetcher.mockResolvedValueOnce(response({ inspection: value }));
    await click("Inspect campaign status");
    expect(button("Retry campaign once")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects inspection for a different business", async () => {
    fetcher.mockResolvedValueOnce(response({ inspection: { ...inspection, businessId: inspection.ownerId } }));
    await click("Inspect campaign status");
    expect(button("Retry campaign once")).toBeUndefined();
    expect(renderToStaticMarkup(render())).toContain("campaign status could not be confirmed");
  });

  it.each([
    { ...authorization, expiresAt: "2000-01-01T00:00:00.000Z" },
    { ...authorization, expiresAt: "2000-01-01T00:00:00.123456+00:00" },
    { ...authorization, expiresAt: "not-a-date" },
    { ...authorization, expiresAt: "2099-10-06T03:12:21" },
    { ...authorization, token: "" },
    { ...authorization, attemptId: "invalid" },
  ])("never executes a missing, expired, or malformed authorization", async value => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization: value }));
    await click("Retry campaign once");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(button("Retry campaign once")).toBeUndefined();
  });

  it("rejects an execute result that belongs to a different review account", async () => {
    await click("Inspect campaign status"); accept();
    fetcher.mockResolvedValueOnce(response({ authorization }))
      .mockResolvedValueOnce(response({ inspection: { ...inspection, accountId: inspection.ownerId } }));
    await click("Retry campaign once");
    expect(renderToStaticMarkup(render())).toContain("retry outcome is not confirmed");
    expect(button("Retry campaign once")).toBeUndefined();
    expect(fetcher.mock.calls).toHaveLength(4);
  });

  it("shows only bounded diagnostic fields without raw payloads, filing, or tokens", async () => {
    fetcher.mockResolvedValueOnce(response({ inspection: { ...inspection, attempts: [{
      ...inspection.attempts[0], diagnostics: {
        status: 422, requestId: "request-example-123", message: "FALLBACK_NOT_NEEDED",
        providerErrors: [
          { code: "10015", title: "Invalid field", detail: "The sample message could not be validated." },
          { code: "10016", detail: "B".repeat(1000) },
          { title: "Third error" }, { title: "FOURTH_ERROR_NOT_SHOWN" },
        ],
        token: "PRIVATE_TOKEN", filing: { address: "PRIVATE_ADDRESS" }, rawPayload: "PRIVATE_RAW_RESPONSE",
      },
    }] } }));
    await click("Inspect campaign status");
    const html = renderToStaticMarkup(render());
    expect(html).toContain("HTTP status: </dt><dd class=\"inline\">422");
    expect(html).toContain("request-example-123");
    expect(html).toContain("10015: ");
    expect(html).toContain("Invalid field");
    expect(html).toContain("sample message could not be validated");
    expect(html).toContain(`${"B".repeat(350)}…`);
    for (const hidden of ["B".repeat(351), "FOURTH_ERROR_NOT_SHOWN", "FALLBACK_NOT_NEEDED", "PRIVATE_TOKEN", "PRIVATE_ADDRESS", "PRIVATE_RAW_RESPONSE"])
      expect(html).not.toContain(hidden);
  });

  it("uses a bounded message when no structured provider errors are available", async () => {
    fetcher.mockResolvedValueOnce(response({ inspection: { ...inspection, attempts: [{
      ...inspection.attempts[0], diagnostics: { status: null, requestId: null, message: "M".repeat(900), providerErrors: [] },
    }] } }));
    await click("Inspect campaign status");
    const html = renderToStaticMarkup(render());
    expect(html).toContain(`${"M".repeat(400)}…`);
    expect(html).not.toContain("M".repeat(401));
    expect(html).not.toContain("HTTP status:");
  });
});
