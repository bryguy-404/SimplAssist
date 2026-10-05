import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  releasePhoneNumber: vi.fn(),
  unassignPhoneNumberCampaign: vi.fn(),
  deactivateCampaign: vi.fn(),
  deleteBrand: vi.fn(),
  deleteMessagingProfile: vi.fn(),
  deleteVoiceApplication: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    phoneNumbers: { delete: mocks.releasePhoneNumber },
    messaging10dlc: {
      phoneNumberCampaigns: { delete: mocks.unassignPhoneNumberCampaign },
      campaign: { deactivate: mocks.deactivateCampaign },
      brand: { delete: mocks.deleteBrand },
    },
    messagingProfiles: { delete: mocks.deleteMessagingProfile },
    callControlApplications: { delete: mocks.deleteVoiceApplication },
  },
}));

import {
  retireReviewUpgradeCampaign,
  deactivateTelnyxCampaign,
  deleteTelnyxBrand,
  deleteTelnyxMessagingProfile,
  deleteTelnyxVoiceApplication,
  preauthorizeTelnyxBrandDeletion,
  releaseTelnyxPhoneNumber,
  TelnyxRemoteMutationAuthorizationError,
  unassignTelnyxPhoneNumberCampaign,
} from "./telnyxDestructive";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const BRYAN_DEVELOPS_BUSINESS_ID =
  "aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb";
const ACTION_ID = "00000000-0000-4000-8000-000000000002";
const LEASE_TOKEN = "00000000-0000-4000-8000-000000000003";
const PROTECTED_MESSAGING_PROFILE_ID =
  "00000000-0000-4000-8000-000000000004";
const PROTECTED_VOICE_APPLICATION_ID = "123456789";

type AuthorizationOverrides = Partial<{
  authorized: unknown;
  business_id: unknown;
  context: unknown;
  operation: unknown;
  action_id: unknown;
  provider_id: unknown;
  canonical_e164: unknown;
  public_tcr_id: unknown;
  config_updated_at: unknown;
}>;

function authorization(
  operation: string,
  overrides: AuthorizationOverrides = {}
) {
  return {
    authorized: true,
    business_id: BUSINESS_ID,
    context: "release_worker",
    operation,
    action_id: ACTION_ID,
    provider_id: "provider-authoritative-id",
    canonical_e164: "+15745550123",
    public_tcr_id: null,
    config_updated_at: "2026-07-22T05:00:00.000Z",
    ...overrides,
  };
}

const workerScope = {
  businessId: BUSINESS_ID,
  context: "release_worker" as const,
  providerId: "caller-stale-id",
  actionId: ACTION_ID,
  leaseToken: LEASE_TOKEN,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED", "1");
  vi.stubEnv(
    "TELNYX_PROTECTED_MESSAGING_PROFILE_ID",
    PROTECTED_MESSAGING_PROFILE_ID
  );
  vi.stubEnv(
    "TELNYX_PROTECTED_VOICE_APPLICATION_ID",
    PROTECTED_VOICE_APPLICATION_ID
  );
  mocks.rpc.mockResolvedValue({
    data: authorization("release_phone_number"),
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("destructive Telnyx authorization boundary", () => {
  it.each([undefined, "", "0", "true", "yes", "01"])(
    "fails closed when the application kill switch is %s",
    async (value) => {
      if (value === undefined) {
        vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED", undefined);
      } else {
        vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED", value);
      }

      await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
        name: "TelnyxRemoteMutationAuthorizationError",
        reason: "kill_switch_disabled",
      });
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["TELNYX_PROTECTED_MESSAGING_PROFILE_ID", ""],
    ["TELNYX_PROTECTED_MESSAGING_PROFILE_ID", "not-a-uuid"],
    ["TELNYX_PROTECTED_VOICE_APPLICATION_ID", ""],
    ["TELNYX_PROTECTED_VOICE_APPLICATION_ID", "not-numeric"],
  ])("requires a valid dedicated %s", async (key, value) => {
    vi.stubEnv(key, value);

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "protected_identifier_configuration_invalid",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it("sends the complete authorization request and uses the authoritative returned ID", async () => {
    await releaseTelnyxPhoneNumber(workerScope);

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "authorize_telnyx_remote_mutation",
      {
        p_business_id: BUSINESS_ID,
        p_context: "release_worker",
        p_operation: "release_phone_number",
        p_provider_id: "caller-stale-id",
        p_action_id: ACTION_ID,
        p_lease_token: LEASE_TOKEN,
        p_expected_shared_messaging_profile_id:
          PROTECTED_MESSAGING_PROFILE_ID,
        p_expected_shared_voice_application_id:
          PROTECTED_VOICE_APPLICATION_ID,
      }
    );
    expect(mocks.releasePhoneNumber).toHaveBeenCalledWith(
      "provider-authoritative-id"
    );
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalledWith(
      "caller-stale-id"
    );
  });

  it.each([
    { provider_id: "changed-provider" },
    { canonical_e164: "+15745550999" },
    { public_tcr_id: "CHANGED" },
    { config_updated_at: "2026-07-22T05:00:01.000Z" },
  ])("fails closed when final authorization changes %#", async (override) => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: authorization("release_phone_number"),
        error: null,
      })
      .mockResolvedValueOnce({
        data: authorization("release_phone_number", override),
        error: null,
      });

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "authorization_response_mismatch",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it("turning the application kill switch off during authorization revokes the call", async () => {
    mocks.rpc.mockImplementation(async () => {
      vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED", "0");
      return {
        data: authorization("release_phone_number"),
        error: null,
      };
    });

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "kill_switch_disabled",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it("changing a protected identifier during authorization revokes the call", async () => {
    mocks.rpc.mockImplementation(async () => {
      vi.stubEnv(
        "TELNYX_PROTECTED_MESSAGING_PROFILE_ID",
        "00000000-0000-4000-8000-000000000099"
      );
      return {
        data: authorization("release_phone_number"),
        error: null,
      };
    });

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "protected_identifier_configuration_changed",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it("turning the database gate off invalidates an already-leased action", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: null,
    });

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "authorization_response_invalid",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it("turns a thrown authorization transport failure into a typed denial", async () => {
    mocks.rpc.mockRejectedValue(new Error("connection reset"));

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      name: "TelnyxRemoteMutationAuthorizationError",
      reason: "authorization_rpc_failed",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { ...authorization("release_phone_number"), unexpected: "field" },
    authorization("release_phone_number", { authorized: false }),
    authorization("release_phone_number", { provider_id: 42 }),
    authorization("release_phone_number", { canonical_e164: 42 }),
    authorization("release_phone_number", { public_tcr_id: 42 }),
    authorization("release_phone_number", { config_updated_at: "invalid" }),
  ])("rejects malformed authoritative JSON %#", async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "authorization_response_invalid",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it.each([
    { business_id: "different-business" },
    { context: "rejection_recovery" },
    { operation: "delete_brand" },
    { action_id: "different-action" },
  ])("rejects an authorization identity mismatch %#", async (override) => {
    mocks.rpc.mockResolvedValue({
      data: authorization("release_phone_number", override),
      error: null,
    });

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "authorization_response_mismatch",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it("requires the authoritative target needed by the requested operation", async () => {
    mocks.rpc.mockResolvedValue({
      data: authorization("release_phone_number", { provider_id: null }),
      error: null,
    });

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toMatchObject({
      reason: "authorized_target_missing",
    });
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it("preauthorizes brand deletion without making a provider call", async () => {
    mocks.rpc.mockResolvedValue({
      data: authorization("delete_brand", {
        context: "rejection_recovery",
        action_id: null,
      }),
      error: null,
    });

    await preauthorizeTelnyxBrandDeletion({
      businessId: BUSINESS_ID,
      context: "rejection_recovery",
      providerId: "brand-id",
    });

    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.deleteBrand).not.toHaveBeenCalled();
  });

  it("runs the campaign fence between preauthorization and a final database authorization", async () => {
    mocks.rpc.mockResolvedValue({
      data: authorization("deactivate_campaign"),
      error: null,
    });
    const beforeMutation = vi.fn().mockResolvedValue("proceed");

    const result = await deactivateTelnyxCampaign(workerScope, {
      beforeMutation,
    });

    expect(result).toBe("deactivated");
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(beforeMutation).toHaveBeenCalledOnce();
    expect(mocks.deactivateCampaign).toHaveBeenCalledOnce();
    expect(mocks.deactivateCampaign).toHaveBeenCalledWith(
      "provider-authoritative-id",
      { maxRetries: 0 }
    );
    expect(mocks.rpc.mock.invocationCallOrder[1]).toBeLessThan(
      beforeMutation.mock.invocationCallOrder[0]
    );
    expect(beforeMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rpc.mock.invocationCallOrder[2]
    );
    expect(mocks.rpc.mock.invocationCallOrder[2]).toBeLessThan(
      mocks.deactivateCampaign.mock.invocationCallOrder[0]
    );
  });

  it("requires every campaign deactivation caller to supply a durable fence", async () => {
    const invokeWithoutFence = deactivateTelnyxCampaign as unknown as (
      scope: typeof workerScope
    ) => Promise<unknown>;

    await expect(invokeWithoutFence(workerScope)).rejects.toMatchObject({
      name: "TelnyxRemoteMutationAuthorizationError",
      reason: "deactivation_fence_missing",
    });

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
  });

  it("rejects an invalid runtime fence decision without calling the provider", async () => {
    mocks.rpc.mockResolvedValue({
      data: authorization("deactivate_campaign"),
      error: null,
    });
    const beforeMutation = vi.fn().mockResolvedValue("invalid");

    await expect(
      deactivateTelnyxCampaign(workerScope, {
        beforeMutation: beforeMutation as () => Promise<"proceed">,
      })
    ).rejects.toMatchObject({
      reason: "deactivation_fence_decision_invalid",
    });

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
  });

  it("returns skipped without calling the provider when the durable fence declines", async () => {
    mocks.rpc.mockResolvedValue({
      data: authorization("deactivate_campaign"),
      error: null,
    });
    const beforeMutation = vi.fn().mockResolvedValue("skip");

    const result = await deactivateTelnyxCampaign(workerScope, {
      beforeMutation,
    });

    expect(result).toBe("skipped");
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(beforeMutation).toHaveBeenCalledOnce();
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
  });

  it("propagates a durable-fence failure without calling the provider", async () => {
    mocks.rpc.mockResolvedValue({
      data: authorization("deactivate_campaign"),
      error: null,
    });
    const fenceError = new Error("deactivation fence unavailable");
    const beforeMutation = vi.fn().mockRejectedValue(fenceError);

    await expect(
      deactivateTelnyxCampaign(workerScope, { beforeMutation })
    ).rejects.toBe(fenceError);

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(beforeMutation).toHaveBeenCalledOnce();
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
  });

  it("revokes campaign deactivation when the runtime gate changes during the durable fence", async () => {
    mocks.rpc.mockResolvedValue({
      data: authorization("deactivate_campaign"),
      error: null,
    });
    const beforeMutation = vi.fn().mockImplementation(async () => {
      vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED", "0");
      return "proceed";
    });

    await expect(
      deactivateTelnyxCampaign(workerScope, { beforeMutation })
    ).rejects.toMatchObject({
      name: "TelnyxRemoteMutationAuthorizationError",
      reason: "kill_switch_disabled",
    });

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(beforeMutation).toHaveBeenCalledOnce();
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
  });

  it("revokes campaign deactivation when database authorization changes during the durable fence", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: authorization("deactivate_campaign"),
        error: null,
      })
      .mockResolvedValueOnce({
        data: authorization("deactivate_campaign"),
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    const beforeMutation = vi.fn().mockResolvedValue("proceed");

    await expect(
      deactivateTelnyxCampaign(workerScope, { beforeMutation })
    ).rejects.toMatchObject({
      name: "TelnyxRemoteMutationAuthorizationError",
      reason: "authorization_response_invalid",
    });

    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(beforeMutation).toHaveBeenCalledOnce();
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
  });

  it("centralizes every lifecycle destructive SDK method", async () => {
    const cases = [
      {
        operation: "unassign_phone_number_campaign",
        invoke: () => unassignTelnyxPhoneNumberCampaign(workerScope),
        sdk: mocks.unassignPhoneNumberCampaign,
        target: "+15745550123",
      },
      {
        operation: "deactivate_campaign",
        invoke: () =>
          deactivateTelnyxCampaign(workerScope, {
            beforeMutation: async () => "proceed",
          }),
        sdk: mocks.deactivateCampaign,
        target: "provider-authoritative-id",
      },
      {
        operation: "delete_brand",
        invoke: () => deleteTelnyxBrand(workerScope),
        sdk: mocks.deleteBrand,
        target: "provider-authoritative-id",
      },
      {
        operation: "delete_messaging_profile",
        invoke: () => deleteTelnyxMessagingProfile(workerScope),
        sdk: mocks.deleteMessagingProfile,
        target: "provider-authoritative-id",
      },
      {
        operation: "delete_voice_application",
        invoke: () => deleteTelnyxVoiceApplication(workerScope),
        sdk: mocks.deleteVoiceApplication,
        target: "provider-authoritative-id",
      },
    ] as const;

    for (const entry of cases) {
      vi.clearAllMocks();
      mocks.rpc.mockResolvedValue({
        data: authorization(entry.operation),
        error: null,
      });

      await entry.invoke();

      expect(mocks.rpc).toHaveBeenCalledWith(
        "authorize_telnyx_remote_mutation",
        expect.objectContaining({ p_operation: entry.operation })
      );
      if (entry.operation === "deactivate_campaign") {
        expect(entry.sdk).toHaveBeenCalledWith(entry.target, { maxRetries: 0 });
      } else {
        expect(entry.sdk).toHaveBeenCalledWith(entry.target);
      }
    }
  });

  it("exposes authorization refusal as a typed domain error", async () => {
    vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED", "0");

    await expect(releaseTelnyxPhoneNumber(workerScope)).rejects.toBeInstanceOf(
      TelnyxRemoteMutationAuthorizationError
    );
  });

  it("never mutates Bryan Develops or its exact live production resources after denial", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const protectedScope = (providerId: string | null) => ({
      businessId: BRYAN_DEVELOPS_BUSINESS_ID,
      context: "release_worker" as const,
      providerId,
      actionId: ACTION_ID,
      leaseToken: LEASE_TOKEN,
    });

    const attempts = [
      releaseTelnyxPhoneNumber(protectedScope("stale-local-phone-id")),
      unassignTelnyxPhoneNumberCampaign(
        protectedScope("stale-local-phone-id")
      ),
      deactivateTelnyxCampaign(protectedScope("CYLIGTZ"), {
        beforeMutation: async () => "proceed",
      }),
      deleteTelnyxBrand(protectedScope("BL69PDP")),
      deleteTelnyxMessagingProfile(
        protectedScope(PROTECTED_MESSAGING_PROFILE_ID)
      ),
      deleteTelnyxVoiceApplication(
        protectedScope(PROTECTED_VOICE_APPLICATION_ID)
      ),
    ];

    const results = await Promise.allSettled(attempts);
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(
          TelnyxRemoteMutationAuthorizationError
        );
      }
    }

    expect(mocks.rpc).toHaveBeenCalledTimes(6);
    for (const [, args] of mocks.rpc.mock.calls) {
      expect(args).toEqual(
        expect.objectContaining({
          p_business_id: BRYAN_DEVELOPS_BUSINESS_ID,
        })
      );
    }
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
    expect(mocks.unassignPhoneNumberCampaign).not.toHaveBeenCalled();
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
    expect(mocks.deleteBrand).not.toHaveBeenCalled();
    expect(mocks.deleteMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.deleteVoiceApplication).not.toHaveBeenCalled();
  });
});

describe("completed review upgrade campaign retirement",()=>{
  const scope={upgradeId:ACTION_ID,claimToken:LEASE_TOKEN,campaignId:"old-campaign"};
  it("uses the exact narrow permit without enabling general resource release",async()=>{
    vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED","0");
    mocks.rpc.mockResolvedValue({data:true,error:null});
    await retireReviewUpgradeCampaign(scope);
    expect(mocks.rpc).toHaveBeenCalledWith("review_texting_retire_permit",expect.objectContaining({p_upgrade:ACTION_ID,p_claim:LEASE_TOKEN,p_campaign:"old-campaign"}));
    expect(mocks.deactivateCampaign).toHaveBeenCalledWith("old-campaign",{maxRetries:0,timeout:10000});
    expect(mocks.releasePhoneNumber).not.toHaveBeenCalled();
    expect(mocks.deleteBrand).not.toHaveBeenCalled();
  });
  it.each([false,null,{authorized:true}])("rejects missing or malformed scoped proof",async(data)=>{
    mocks.rpc.mockResolvedValue({data,error:null});
    await expect(retireReviewUpgradeCampaign(scope)).rejects.toBeInstanceOf(TelnyxRemoteMutationAuthorizationError);
    expect(mocks.deactivateCampaign).not.toHaveBeenCalled();
  });
  it("does not retry an ambiguous provider deletion",async()=>{
    mocks.rpc.mockResolvedValue({data:true,error:null});
    mocks.deactivateCampaign.mockRejectedValueOnce(new Error("timeout"));
    await expect(retireReviewUpgradeCampaign(scope)).rejects.toThrow("timeout");
    expect(mocks.deactivateCampaign).toHaveBeenCalledTimes(1);
  });
});
