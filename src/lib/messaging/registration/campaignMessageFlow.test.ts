import { describe, expect, it } from "vitest";

import {
  buildSmsComplianceCopy,
  MOBILE_INFORMATION_SHARING_DISCLOSURE,
} from "@/lib/messaging/complianceCopy";
import {
  buildCampaignMessageFlow,
  CampaignMessageFlowError,
  TELNYX_CAMPAIGN_MESSAGE_FLOW_MAX_CHARACTERS,
} from "./campaignMessageFlow";

const BASE_ARGS = {
  business: {
    name: "Northstar Home Care",
    email: "help@northstar.example",
    phone_number: "+13175550199",
  },
  smsPhoneNumber: "+13175550123",
  smsEntryPoint: "https://app.example.test/c/northstar-home-care",
  privacyUrl: "https://app.example.test/c/northstar-home-care/privacy",
};

function argsWithMessageFlowLength(targetLength: number) {
  const seed = buildSmsComplianceCopy(BASE_ARGS).messageFlow.length;
  const paddingLength = targetLength - seed;
  if (paddingLength < 0) {
    throw new Error(`Test seed is already ${seed} characters`);
  }

  const args = {
    ...BASE_ARGS,
    privacyUrl: `${BASE_ARGS.privacyUrl}${"x".repeat(paddingLength)}`,
  };
  const actualLength = buildSmsComplianceCopy(args).messageFlow.length;
  if (actualLength !== targetLength) {
    throw new Error(
      `Could not construct ${targetLength}-character flow (got ${actualLength})`
    );
  }
  return args;
}

describe("buildCampaignMessageFlow", () => {
  it("requires and normalizes a real E.164 SMS number", () => {
    const copy = buildCampaignMessageFlow({
      ...BASE_ARGS,
      smsPhoneNumber: "  +13175550123  ",
    });

    expect(copy.smsPhoneNumber).toBe("+13175550123");
    expect(copy.messageFlowCharacterCount).toBe(copy.messageFlow.length);
    expect(copy.optInPaths.inboundSms).toContain("+13175550123");
    expect(copy.optInPaths.voicemail).toContain("+13175550123");
    expect(copy.messageFlow).toContain(BASE_ARGS.smsEntryPoint);
    expect(copy.messageFlow).toContain(BASE_ARGS.privacyUrl);
    expect(copy.messageFlow).not.toContain(BASE_ARGS.business.phone_number);
  });

  it.each([
    "",
    "   ",
    "13175550123",
    "+03175550123",
    "+1317-555-0123",
    "+1234567",
    "+1234567890123456",
  ])("rejects missing or malformed SMS number %j", (smsPhoneNumber) => {
    expect(() =>
      buildCampaignMessageFlow({ ...BASE_ARGS, smsPhoneNumber })
    ).toThrow(
      expect.objectContaining({
        name: "CampaignMessageFlowError",
        code: "campaign_sms_number_invalid",
        kind: "permanent",
      })
    );
  });

  it("quotes the actual confirmation and voicemail scripts verbatim", () => {
    const copy = buildCampaignMessageFlow(BASE_ARGS);

    expect(copy.messageFlow).toContain(
      `Confirmation SMS: “${copy.confirmationSms}”`
    );
    expect(copy.messageFlow).toContain(
      `Voicemail disclosure: “${copy.voicemailGreeting}”`
    );
    expect(copy.messageFlow).toContain(
      MOBILE_INFORMATION_SHARING_DISCLOSURE
    );
    expect(copy.messageFlow).toContain(copy.disclosures.help);
    expect(copy.messageFlow).toContain(copy.disclosures.stop);
    expect(copy.messageFlow).toContain(copy.disclosures.frequency);
    expect(copy.messageFlow).toContain(copy.disclosures.rates);
  });

  it("uses the selected Spanish scripts verbatim in campaign copy", () => {
    const copy = buildCampaignMessageFlow({
      ...BASE_ARGS,
      language: "es",
    });

    expect(copy.confirmationSms).toBe(
      "Hola, somos Northstar Home Care — vimos tu llamada. Solo responde aquí con lo que necesitas y nos encargaremos de ayudarte.\n\nLa frecuencia de mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde HELP para recibir ayuda o STOP para dejar de recibir mensajes."
    );
    expect(copy.voicemailGreeting).toBe(
      "Gracias por llamar a Northstar Home Care. Al dejar un mensaje después del tono, te responderemos por mensaje de texto."
    );
    expect(copy.messageFlow).toContain(
      `Confirmation SMS: “${copy.confirmationSms}”`
    );
    expect(copy.messageFlow).toContain(
      `Voicemail disclosure: “${copy.voicemailGreeting}”`
    );
  });

  it("accepts a message flow exactly at the 2,048-character limit", () => {
    expect(TELNYX_CAMPAIGN_MESSAGE_FLOW_MAX_CHARACTERS).toBe(2_048);
    const args = argsWithMessageFlowLength(2_048);

    const copy = buildCampaignMessageFlow(args);

    expect(copy.messageFlowCharacterCount).toBe(2_048);
  });

  it("rejects a message flow one character over the limit", () => {
    const overLimit = 2_049;
    const args = argsWithMessageFlowLength(overLimit);

    try {
      buildCampaignMessageFlow(args);
      throw new Error("Expected over-limit message flow to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CampaignMessageFlowError);
      expect(error).toMatchObject({
        code: "campaign_message_flow_too_long",
        kind: "permanent",
        message: expect.stringContaining(`${overLimit} characters`),
      });
    }
  });
});

describe("separate review opt-in for a new MIXED campaign", () => {
  it.each(["en", "es"] as const)("keeps customer care and REVIEWS consent separate inside the provider limit (%s)", (language) => {
    const copy = buildCampaignMessageFlow({
      ...BASE_ARGS,
      language,
      reviewConsentPageUrl: "https://app.example.test/c/northstar-home-care/review-texts",
      termsUrl: "https://app.example.test/c/northstar-home-care/terms",
    });
    expect(copy.messageFlow).toContain("text REVIEWS to +13175550123");
    expect(copy.messageFlow).toContain("Customer-care permission and START do not authorize review requests");
    expect(copy.messageFlow).toContain(copy.voicemailGreeting);
    expect(copy.messageFlow).toContain(copy.confirmationSms);
    expect(copy.messageFlow).toContain("up to 2 review messages per completed service");
    expect(copy.optinMessage).toContain("agreed to automated review-request texts");
    expect(copy.messageFlowCharacterCount).toBeLessThanOrEqual(2048);
  });
});
