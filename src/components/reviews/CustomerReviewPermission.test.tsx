import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormEvent, ReactElement } from "react";
const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "permission-form",
  useEffect: () => undefined,
  useState: <T,>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [
      harness.states[index],
      (next: T) => {
        harness.states[index] = next;
      },
    ];
  },
}));
import CustomerReviewPermission from "./CustomerReviewPermission";
beforeEach(() => {
  harness.states = [];
  harness.cursor = 0;
});
afterEach(() => vi.unstubAllGlobals());
function formSubmit(input: Record<string, string>, onBusyChange = vi.fn()) {
  vi.stubGlobal(
    "FormData",
    class {
      get(key: string) {
        return input[key] || null;
      }
    },
  );
  const component = CustomerReviewPermission({
    customerId: "customer-id",
    onBusyChange,
  });
  const form = (component.props.children as ReactElement[]).find(
    (child) => child?.type === "form",
  )!;
  return form.props.onSubmit({
    preventDefault: vi.fn(),
    currentTarget: {},
  } as unknown as FormEvent<HTMLFormElement>);
}
describe("customer review permission evidence", () => {
  it("offers a hosted consent link and prevents manual text grants for keyword programs", () => {
    harness.states[3] = [];
    harness.states[5] = {
      required: true,
      url: "https://simplassist.com/c/example/review-texts",
    };
    harness.states[6] = "sms";
    const html = renderToStaticMarkup(
      CustomerReviewPermission({ customerId: "customer-id" }),
    );
    expect(html).toContain("Share your permission page");
    expect(html).not.toContain('value="granted"');
    expect(html).toContain('value="withdrawn"');
  });
  it("shows automatic customer permission without assuming an owner actor", () => {
    harness.states[3] = [
      {
        channel: "sms",
        destination: "+15745550106",
        status: "granted",
        grantedAt: "2026-10-03T13:00:00Z",
        revokedAt: null,
        source: "customer_keyword",
        evidence:
          "Customer sent REVIEWS from this phone after the review-text disclosures.",
      },
    ];
    const html = renderToStaticMarkup(
      CustomerReviewPermission({ customerId: "customer-id" }),
    );
    expect(html).toContain("Customer texted REVIEWS");
    expect(html).toContain("Permission recorded");
    expect(html).not.toContain("Recorded by your business");
  });
  it("does not present a suppressed self-consent as permission to send", () => {
    harness.states[3] = [
      {
        channel: "sms",
        destination: "+15745550106",
        status: "suppressed",
        grantedAt: "2026-10-03T13:00:00Z",
        revokedAt: "2026-10-03T14:00:00Z",
        source: "customer_keyword",
        evidence: "Customer sent REVIEWS.",
      },
    ];
    expect(
      renderToStaticMarkup(
        CustomerReviewPermission({ customerId: "customer-id" }),
      ),
    ).toContain("Opted out — sending blocked");
  });
  it("records explicit channel and timezone evidence without sending or enrolling", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ saved: true }))
      .mockResolvedValue(Response.json({ permissions: [] }));
    vi.stubGlobal("fetch", fetch);
    await formSubmit({
      channel: "sms",
      decision: "granted",
      evidence: "  Agreed on the service form on October 3.  ",
      timezone: "America/Chicago",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("/api/reviews/permissions");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      contactId: "customer-id",
      channel: "sms",
      granted: true,
      evidence: "Agreed on the service form on October 3.",
      timezone: "America/Chicago",
    });
    harness.cursor = 0;
    expect(
      renderToStaticMarkup(
        CustomerReviewPermission({ customerId: "customer-id" }),
      ),
    ).toContain("Existing opt-outs remain in place");
  });
  it("does not present withdrawn permission as saved when the server rejects it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "Customer unavailable" }, { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    const onBusyChange = vi.fn();
    await formSubmit(
      {
        channel: "email",
        decision: "withdrawn",
        evidence: "Customer asked to stop review requests.",
      },
      onBusyChange,
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body).granted).toBe(false);
    harness.cursor = 0;
    const html = renderToStaticMarkup(
      CustomerReviewPermission({ customerId: "customer-id" }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Customer unavailable");
    expect(html).not.toContain("Permission withdrawn for this channel.");
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
});
