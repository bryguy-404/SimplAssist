import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveBusinessEmailBrand: vi.fn(),
  sendBusinessEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./businessEmailBrand.server", () => ({
  resolveBusinessEmailBrand: mocks.resolveBusinessEmailBrand,
}));
vi.mock("./sender", () => ({
  sendBusinessEmail: mocks.sendBusinessEmail,
}));
vi.mock("./client", () => ({
  RESEND_FROM: "SimplAssist <notifications@simplassist.com>",
  resend: { emails: { send: vi.fn() } },
}));

import {
  dedupeRecipients,
  sendBrandApprovedEmail,
  sendBrandRejectedEmail,
  sendCampaignApprovedEmail,
  sendCampaignRejectedEmail,
} from "./registrationStatus";
import { sendSupportTicketEmail } from "./supportTicket";
import { sendA2pRiskReviewEmail } from "./a2pRiskReview";
import { RESEND_FROM } from "./client";
import { SUPPORT_EMAIL } from "@/lib/support/constants";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const PARTNER_BRAND = {
  partnerId: "00000000-0000-4000-8000-000000000002",
  name: "Alpha Dog Agency",
  publicOrigin: "https://app.alphadogagency.ai",
  from: '"Alpha Dog Agency" <hello@alphadogagency.ai>',
  usedFallbackSender: false,
};
const DEFAULT_BRAND = {
  partnerId: null,
  name: "SimplAssist",
  publicOrigin: "https://simplassist.com",
  from: "SimplAssist <notifications@simplassist.com>",
  usedFallbackSender: false,
};

function sentMessage() {
  const call = mocks.sendBusinessEmail.mock.calls[0]?.[0] as {
    brand: typeof PARTNER_BRAND;
    context: string;
    message: {
      to: string[];
      replyTo?: string;
      subject: string;
      text: string;
      html: string;
    };
  };
  if (!call) throw new Error("Expected an email send");
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.resolveBusinessEmailBrand.mockResolvedValue(PARTNER_BRAND);
  mocks.sendBusinessEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("registration-status business branding", () => {
  it("preserves recipient normalization", () => {
    expect(
      dedupeRecipients([
        " Owner@Example.com ",
        "owner@example.com",
        null,
        "rep@example.com",
      ]),
    ).toEqual(["owner@example.com", "rep@example.com"]);
  });

  it("uses the assigned brand in an approval subject, signature, and sender", async () => {
    await sendBrandApprovedEmail({
      businessId: BUSINESS_ID,
      businessName: "Bryan's Plumbing",
      recipients: ["owner@example.com"],
    });

    expect(mocks.resolveBusinessEmailBrand).toHaveBeenCalledWith(BUSINESS_ID);
    expect(sentMessage()).toMatchObject({
      brand: PARTNER_BRAND,
      context: "registrationStatus:brand_approved",
      message: {
        to: ["owner@example.com"],
        subject: "Your Alpha Dog Agency business verification is approved",
      },
    });
    expect(sentMessage().message.text).toContain("— The Alpha Dog Agency Team");
    expect(sentMessage().message.text).toContain("business verification alone does not activate it");
    expect(sentMessage().message.html).toContain("Bryan&#39;s Plumbing");
  });

  it("routes rejected brands to the branded registration-support form", async () => {
    await sendBrandRejectedEmail({
      businessId: BUSINESS_ID,
      businessName: "Acme Plumbing",
      rejectionReason: "EIN mismatch",
      recipients: ["owner@example.com"],
    });

    const { message } = sentMessage();
    expect(message.subject).toBe(
      "Your Alpha Dog Agency business registration needs support",
    );
    expect(message.text).toContain(
      "https://app.alphadogagency.ai/support?category=number_registration",
    );
    expect(message.html).toContain(
      'href="https://app.alphadogagency.ai/support?category=number_registration"',
    );
    expect(message.text).toContain("Reason from the carrier: EIN mismatch");
    expect(message.text).not.toMatch(/fix & resubmit|resubmit|re-file/i);
  });

  it("uses the partner origin for campaign approval and rejection support", async () => {
    const input = {
      businessId: BUSINESS_ID,
      businessName: "Acme Plumbing",
      recipients: ["owner@example.com"],
    };

    await sendCampaignApprovedEmail(input);
    expect(sentMessage().message).toMatchObject({
      subject: "Your Alpha Dog Agency SMS campaign is live",
    });
    expect(sentMessage().message.text).toContain(
      "https://app.alphadogagency.ai/dashboard",
    );

    vi.clearAllMocks();
    mocks.resolveBusinessEmailBrand.mockResolvedValue(PARTNER_BRAND);
    mocks.sendBusinessEmail.mockResolvedValue(undefined);
    await sendCampaignRejectedEmail({
      ...input,
      rejectionReason: "Sample message was rejected",
    });
    expect(sentMessage().message.subject).toBe(
      "Your Alpha Dog Agency SMS campaign needs support",
    );
    expect(sentMessage().message.text).toContain(
      "https://app.alphadogagency.ai/support?category=number_registration",
    );
    expect(sentMessage().message.html).toContain(
      'href="https://app.alphadogagency.ai/support?category=number_registration"',
    );
    expect(sentMessage().message.text).toContain(
      "Reason from the carrier: Sample message was rejected",
    );
    expect(sentMessage().message.text).not.toMatch(/resubmit|dashboard/i);
  });

  it("preserves the existing SimplAssist subject under the default brand", async () => {
    mocks.resolveBusinessEmailBrand.mockResolvedValue(DEFAULT_BRAND);

    await sendCampaignApprovedEmail({
      businessId: BUSINESS_ID,
      businessName: "Acme Plumbing",
      recipients: ["owner@example.com"],
    });

    expect(sentMessage().message.subject).toBe(
      "Your SimplAssist SMS campaign is live",
    );
    expect(sentMessage().message.text).toContain(
      "https://simplassist.com/dashboard",
    );
  });

  it("keeps Alpha Dog presentation while an unverified sender uses the default From", async () => {
    const fallbackPartnerBrand = {
      ...PARTNER_BRAND,
      from: RESEND_FROM,
      usedFallbackSender: true,
    };
    mocks.resolveBusinessEmailBrand.mockResolvedValue(fallbackPartnerBrand);

    await sendCampaignApprovedEmail({
      businessId: BUSINESS_ID,
      businessName: "Acme Plumbing",
      recipients: ["owner@example.com"],
    });

    const sent = sentMessage();
    expect(sent.brand).toEqual(fallbackPartnerBrand);
    expect(sent.brand.from).toBe(RESEND_FROM);
    expect(sent.message.subject).toBe(
      "Your Alpha Dog Agency SMS campaign is live",
    );
    expect(sent.message.text).toContain("Alpha Dog Agency dashboard");
    expect(sent.message.text).toContain(
      "https://app.alphadogagency.ai/dashboard",
    );
  });

  it("does not send a fallback customer email when assignment resolution fails", async () => {
    mocks.resolveBusinessEmailBrand.mockRejectedValue(
      new Error("partner lookup failed"),
    );

    await expect(
      sendBrandApprovedEmail({
        businessId: BUSINESS_ID,
        businessName: "Acme Plumbing",
        recipients: ["owner@example.com"],
      }),
    ).resolves.toBeUndefined();

    expect(mocks.sendBusinessEmail).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[email:registrationStatus] brand_approved send failed:",
      expect.any(Error),
    );
  });

  it("preserves no-throw webhook behavior when the sender rejects", async () => {
    mocks.sendBusinessEmail.mockRejectedValue(new Error("Resend rejected"));

    await expect(
      sendCampaignApprovedEmail({
        businessId: BUSINESS_ID,
        businessName: "Acme Plumbing",
        recipients: ["owner@example.com"],
      }),
    ).resolves.toBeUndefined();
    expect(mocks.sendBusinessEmail).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      "[email:registrationStatus] campaign_approved send failed:",
      expect.any(Error),
    );
  });
});

describe("operator notification business branding", () => {
  it("forwards the persisted business ID from risk screening into email resolution", () => {
    const source = readFileSync(
      new URL("../messaging/registration/riskScreening.ts", import.meta.url),
      "utf8",
    );
    const sendStart = source.indexOf("await sendA2pRiskReviewEmail({");
    const sendEnd = source.indexOf("});", sendStart);
    const sendCall = source.slice(sendStart, sendEnd);

    expect(sendStart).toBeGreaterThan(-1);
    expect(sendCall).toContain("businessId: args.businessId");
    expect(sendCall).not.toMatch(/host|preview/i);
  });

  it("keeps the support recipient while including resolved brand identity and sender", async () => {
    await expect(
      sendSupportTicketEmail({
        requestId: "ticket-1",
        category: "billing",
        message: "Please help with this invoice.",
        name: "Jane Smith",
        email: "jane@example.com",
        userId: "00000000-0000-4000-8000-000000000003",
        businessId: BUSINESS_ID,
        businessName: "Acme Plumbing",
      }),
    ).resolves.toBe(true);

    expect(mocks.resolveBusinessEmailBrand).toHaveBeenCalledWith(BUSINESS_ID);
    const { message } = sentMessage();
    expect(message.to).toEqual([SUPPORT_EMAIL]);
    expect(message.replyTo).toBe("jane@example.com");
    expect(message.subject).toContain("Alpha Dog Agency");
    expect(message.text).toContain("Workspace brand: Alpha Dog Agency");
    expect(message.text).toContain(`Email sender: ${PARTNER_BRAND.from}`);
    expect(message.text).toContain(PARTNER_BRAND.publicOrigin);
  });

  it("does not mark support notified when brand resolution fails", async () => {
    mocks.resolveBusinessEmailBrand.mockRejectedValue(
      new Error("partner lookup failed"),
    );

    await expect(
      sendSupportTicketEmail({
        requestId: "ticket-1",
        category: "billing",
        message: "Please help with this invoice.",
        name: "Jane Smith",
        email: "jane@example.com",
        userId: null,
        businessId: BUSINESS_ID,
        businessName: "Acme Plumbing",
      }),
    ).resolves.toBe(false);
    expect(mocks.sendBusinessEmail).not.toHaveBeenCalled();
  });

  it("returns false when the business-aware sender rejects", async () => {
    mocks.sendBusinessEmail.mockRejectedValue(new Error("Resend rejected"));

    await expect(
      sendSupportTicketEmail({
        requestId: "ticket-1",
        category: "billing",
        message: "Please help with this invoice.",
        name: "Jane Smith",
        email: "jane@example.com",
        userId: null,
        businessId: BUSINESS_ID,
        businessName: "Acme Plumbing",
      }),
    ).resolves.toBe(false);
  });

  it("keeps A2P operator recipients and includes the partner identity", async () => {
    vi.stubEnv("A2P_REVIEW_EMAIL", "risk@simplassist.com");

    await sendA2pRiskReviewEmail({
      businessId: BUSINESS_ID,
      businessName: "Acme Plumbing",
      websiteUrl: "https://acme.example",
      inputHash: "risk-hash",
      findings: [
        {
          ruleId: "review-1",
          category: "review",
          severity: "review",
          label: "Manual check",
          evidence: ["example evidence"],
          source: "website",
        },
      ],
      message: "Manual review is required.",
    });

    expect(mocks.resolveBusinessEmailBrand).toHaveBeenCalledWith(BUSINESS_ID);
    const { message } = sentMessage();
    expect(message.to).toEqual(["risk@simplassist.com"]);
    expect(message.subject).toBe(
      "A2P review needed: Alpha Dog Agency — Acme Plumbing",
    );
    expect(message.text).toContain("Workspace brand: Alpha Dog Agency");
    expect(message.text).toContain(`Email sender: ${PARTNER_BRAND.from}`);
  });

  it("suppresses A2P mail when assignment resolution fails", async () => {
    vi.stubEnv("A2P_REVIEW_EMAIL", "risk@simplassist.com");
    mocks.resolveBusinessEmailBrand.mockRejectedValue(
      new Error("partner lookup failed"),
    );

    await expect(
      sendA2pRiskReviewEmail({
        businessId: BUSINESS_ID,
        businessName: "Acme Plumbing",
        websiteUrl: null,
        inputHash: "risk-hash",
        findings: [],
        message: "Manual review is required.",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.sendBusinessEmail).not.toHaveBeenCalled();
  });
});
