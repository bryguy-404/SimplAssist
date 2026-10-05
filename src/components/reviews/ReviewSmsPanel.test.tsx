import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReviewSmsAccount,
  ReviewSmsOverview,
} from "@/lib/billing/reviewSms";

const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, hashTarget: vi.fn(() => ({ current: null })) }));
vi.mock("@/lib/ui/useHashTarget", () => ({ useHashTarget: harness.hashTarget }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
vi.mock("@/components/phone/PhoneNumberSelector", () => ({
  default: () => null,
}));
import ReviewSmsPanel, { smsPriceSummary } from "./ReviewSmsPanel";

const overview: ReviewSmsOverview = {
  enabled: true,
  account: null,
  canSend: false,
  eligibleSource: "direct",
  price: { monthlyCents: 2000, activationCents: 2500, includedParts: 250 },
};
function render(value: ReviewSmsOverview | null, extraStates: unknown[] = []) {
  harness.states = [value, ...extraStates];
  harness.cursor = 0;
  return renderToStaticMarkup(<ReviewSmsPanel onStatusChanged={vi.fn()} />);
}
beforeEach(() => {
  harness.states = [];
  harness.cursor = 0;
  harness.hashTarget.mockClear();
});
describe("review texting pricing and lifecycle presentation", () => {
  it("locks staged shared legal details before a provider brand is attached", () => {
    const html = render({ ...overview,
      sharedRegistration: { status: "approved", legalBusinessName: "Example Operator LLC", identityVersion: 1 },
      setup: { missing: [], fields: { identityLocked: false, representativeEditable: true, hasEin: false, legalBusinessName: "STALE_NAME",
        publicAddressVisibility: "city_state", address: "100 Private Street", city: "South Bend", state: "IN", zip: "46601",
        entityType: "llc", authorizedRepName: "Owner", authorizedRepEmail: "owner@example.test", authorizedRepPhone: "+15745550123" } },
    });
    expect(html).toContain("Uses your existing legal registration");
    expect(html).toContain("Example Operator LLC");
    expect(html).not.toContain("STALE_NAME");
    expect(html).toContain("show only the city and state");
    expect(html).toContain("Each business needs its own approved review-text program and number");
    for (const name of ["legalBusinessName", "address", "city", "zip"]) {
      expect(html).toMatch(new RegExp(`<input[^>]*name="${name}"[^>]*readonly=""`));
    }
    for (const name of ["authorizedRepName", "authorizedRepEmail", "authorizedRepPhone"]) {
      expect(html).toMatch(new RegExp(`<input[^>]*name="${name}"[^>]*required=""`));
      expect(html).not.toMatch(new RegExp(`<input[^>]*name="${name}"[^>]*readonly=""`));
    }
    expect(html).toContain("Enter the representative authorized to manage texting for this business");
    expect(html).toMatch(/<select[^>]*name="state"[^>]*disabled=""/);
    expect(html).toMatch(/<select[^>]*name="entityType"[^>]*disabled=""/);
    expect(html).not.toContain('name="ein"');
  });
  it("does not promise address privacy for an existing full-address account", () => {
    const html = render({ ...overview,
      sharedRegistration: { status: "active", legalBusinessName: "Example LLC", identityVersion: 1 },
      setup: { missing: [], fields: { publicAddressVisibility: "full" } },
    });
    expect(html).toContain("registered business address is used for carrier approval");
    expect(html).not.toContain("show only the city and state");
    for (const name of ["authorizedRepName", "authorizedRepEmail", "authorizedRepPhone"]) {
      expect(html).toMatch(new RegExp(`<input[^>]*name="${name}"[^>]*readonly=""`));
    }
  });
  it.each([null, "draft", "ready_unpaid"])("offers no new paid setup when shared registration is revoked (%s)", (state) => {
    const html = render({ ...overview,
      sharedRegistration: { status: "revoked", legalBusinessName: "Example LLC", identityVersion: 1 },
      account: state ? { state, draft: {} } as ReviewSmsAccount : null,
    });
    expect(html).toContain("This legal registration is unavailable");
    expect(html).not.toContain("Save approval details");
    expect(html).not.toContain("Pay $25.00");
    expect(html).not.toContain("Review activation price");
    expect(html).toContain("Check status");
  });
  it("waits for the full texting panel or a terminal loading error before resolving its anchor", () => {
    render(null);
    expect(harness.hashTarget).toHaveBeenLastCalledWith("review-sms", false);
    render(overview);
    expect(harness.hashTarget).toHaveBeenLastCalledWith("review-sms", true);
    render(null, [false, false, "Could not load texting settings"]);
    expect(harness.hashTarget).toHaveBeenLastCalledWith("review-sms", true);
  });
  it("offers no activation or setup actions when review texting is disabled", () => {
    const html = render({ ...overview, enabled: false });
    expect(html).toContain(
      "Review texting is not available for this account yet",
    );
    expect(html).not.toContain("Save approval details");
    expect(html).not.toContain("Pay $25.00");
    expect(html).not.toContain("Review activation price");
  });
  it("quotes the add-on without replacing a grandfathered base price", () => {
    expect(smsPriceSummary(overview)).toBe(
      "$20.00/month added to your current plan after approval and activation",
    );
    expect(smsPriceSummary(overview)).not.toMatch(/\$35|\$15/);
    expect(
      smsPriceSummary({ ...overview, eligibleSource: "included" }),
    ).toContain("Included with your texting plan");
    expect(
      smsPriceSummary({ ...overview, eligibleSource: "grant" }),
    ).not.toContain("$20");
  });
  it("shows the submitted-attempt terms and requires agreement before checkout", () => {
    const account = {
      state: "draft",
      draft: { phoneNumber: "+15745550123" },
    } as unknown as ReviewSmsAccount;
    const html = render({ ...overview, account });
    expect(html).toContain("refundable before submission");
    expect(html).toContain(
      "SimplAssist covers corrections caused by its own mistakes",
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Pay \$25.00 and request approval<\/button>/,
    );
    expect(html).not.toContain("Text is now available when creating");
  });
  it("does not offer card checkout for included or partner-managed access", () => {
    const account = {
      state: "draft",
      draft: { phoneNumber: "+15745550123" },
    } as unknown as ReviewSmsAccount;
    expect(
      render({ ...overview, eligibleSource: "included", account }),
    ).not.toContain("Pay $25.00");
    const partner = render({ ...overview, eligibleSource: "grant" });
    expect(partner).toContain("This screen does not charge your card");
    expect(partner).not.toContain("Pay $25.00");
  });
  it("keeps zero prorated allowance and displays the port-out deadline", () => {
    const account = {
      state: "cancel_pending",
      draft: {},
      period_allowance: 0,
      paid_period_end: "2026-11-03T14:00:00Z",
      cancel_at: "2026-11-03T14:00:00Z",
    } as unknown as ReviewSmsAccount;
    const html = render({ ...overview, account, canSend: true });
    expect(html).toContain("0 parts in the current period");
    expect(html).toContain("Complete any number transfer before then");
    expect(html).toContain("your base plan remains active");
  });
  it("removes the refund action once provider submission begins", () => {
    const account = {
      state: "carrier_pending",
      draft: {},
      activation_paid_at: "2026-10-03T14:00:00Z",
      provider_started_at: "2026-10-03T14:01:00Z",
    } as unknown as ReviewSmsAccount;
    expect(render({ ...overview, account })).not.toContain(
      "Cancel before submission and refund activation",
    );
    expect(
      render({
        ...overview,
        account: { ...account, provider_started_at: null },
      }),
    ).toContain("Cancel before submission and refund activation");
  });
});

describe("shared activation start and recovery presentation", () => {
  const staged = { status: "approved" as const, legalBusinessName: "Example LLC", identityVersion: 1 };
  it.each([false, undefined])("hides fresh activation payment when shared paid starts are unavailable (%s)", allowed => {
    const html = render({ ...overview, sharedRegistration: { ...staged, newPaidStartsAllowed: allowed },
      account: { state: "activation_pending", draft: {}, activation_paid_at: null } as ReviewSmsAccount });
    expect(html).not.toContain("Pay $25.00"); expect(html).not.toContain("Continue activation");
    expect(html).toContain("New text review activations are not available"); expect(html).toContain("Check status");
  });
  it("shows the new payment only after paid-start admission is enabled", () => {
    const html = render({ ...overview, sharedRegistration: { ...staged, newPaidStartsAllowed: true },
      account: { state: "draft", draft: {}, activation_paid_at: null } as ReviewSmsAccount });
    expect(html).toContain("Pay $25.00"); expect(html).not.toContain("Continue activation");
  });
  it.each(["approved", "revoked"] as const)("retains an already-authorized activation recovery action with starts stopped (%s)", status => {
    const html = render({ ...overview, sharedRegistration: { ...staged, status, newPaidStartsAllowed: false, activationRecoveryAvailable: true },
      account: { state: "activation_pending", draft: {}, activation_paid_at: null } as ReviewSmsAccount });
    expect(html).toContain("Continue activation"); expect(html).toContain("Check status"); expect(html).not.toContain("Pay $25.00");
  });
  it("keeps the unused activation refund available when new starts are disabled", () => {
    const html = render({ ...overview, sharedRegistration: { ...staged, newPaidStartsAllowed: false },
      account: { state: "carrier_pending", draft: {}, activation_paid_at: "2026-10-05T12:00:00Z", provider_started_at: null } as ReviewSmsAccount });
    expect(html).toContain("Cancel before submission and refund activation"); expect(html).toContain("Check status");
  });
});
