import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),row:vi.fn(),reconcile:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({supabaseAdmin:{rpc:mocks.rpc,from:()=>({select:()=>({eq:()=>({maybeSingle:mocks.row})})})}}));
vi.mock("./reviewTextingProvider.server",()=>({reconcileReviewTextingProvider:mocks.reconcile}));
import { isReviewTextingHandoffPaused, reconcileReviewTextingCampaignEvent } from "./reviewTextingHandoff.server";
beforeEach(()=>{vi.clearAllMocks();});
describe("review handoff boundaries",()=>{
  it.each([true,false])("returns an authoritative pause of %s",async(value)=>{
    mocks.rpc.mockResolvedValue({data:value,error:null});
    expect(await isReviewTextingHandoffPaused("business")).toBe(value);
    expect(mocks.rpc).toHaveBeenCalledWith("review_texting_upgrade_sms_paused",{p_business:"business"});
  });
  it.each([{data:null,error:null},{data:false,error:{message:"unavailable"}}])("fails closed when pause proof is unavailable",async(result)=>{
    mocks.rpc.mockResolvedValue(result);
    await expect(isReviewTextingHandoffPaused("business")).rejects.toThrow("unavailable");
  });
  it("reconciles a known staged campaign before ordinary current-campaign lookup",async()=>{
    mocks.row.mockResolvedValue({data:{upgrade_id:"upgrade",stage:"moving"},error:null});
    expect(await reconcileReviewTextingCampaignEvent("candidate")).toBe(true);
    expect(mocks.reconcile).toHaveBeenCalledWith("upgrade");
  });
  it.each([null,{upgrade_id:"upgrade",stage:"review_ready"}])("leaves unknown or completed campaigns with normal status handling",async(data)=>{
    mocks.row.mockResolvedValue({data,error:null});
    expect(await reconcileReviewTextingCampaignEvent("campaign")).toBe(false);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
