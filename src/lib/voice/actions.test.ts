import { describe, it, expect } from "vitest";
import { actionFingerprint, voiceActionPayload, safeConfirmation, buildActionReadback } from "./actions";
describe("voice action boundaries", () => {
  it("keeps SMS recipient and URL out of model inputs", () => {
    expect(voiceActionPayload.safeParse({kind:"signup",phone:"+15555550100"}).success).toBe(false);
    expect(voiceActionPayload.safeParse({kind:"signup",url:"https://wrong.test"}).success).toBe(false);
  });
  it("permits booking without email but validates any supplied email and local time", () => {
    const booking={kind:"booking",name:"Bryan",phone:"+15555550100",service:"Inspection",startTime:"2026-09-21T10:00:00"};
    expect(voiceActionPayload.safeParse(booking).success).toBe(true);
    expect(voiceActionPayload.safeParse({...booking,email:"bryan at mail"}).success).toBe(false);
    expect(voiceActionPayload.safeParse({...booking,startTime:booking.startTime+"Z"}).success).toBe(false);
  });
  it("distinguishes corrected requests, normalizes email, and pins signup URL", () => {
    const a={kind:"contact" as const,name:"Bryan",phone:"+15555550100",email:"Bryan@example.test"};
    expect(actionFingerprint(a)).toBe(actionFingerprint({...a,email:"bryan@example.test"}));
    expect(actionFingerprint(a)).not.toBe(actionFingerprint({...a,name:"Brian"}));
    expect(actionFingerprint({kind:"signup"},"https://a.test")).not.toBe(actionFingerprint({kind:"signup"},"https://b.test"));
  });
  it("rejects corrections, questions and conditional assent", () => {
    for(const s of ["Yes, but Tuesday", "No", "yes?", "if it's free, yes", "the caller says yes", "yes cancel it"]) expect(safeConfirmation(s),s).toBe(false);
    expect(safeConfirmation("Yes please.")).toBe(true);
  });
  it("does not describe an owner-reviewed request as a booking", () => {
    expect(buildActionReadback({kind:"booking_request",name:"Bryan",phone:"+15555550100",service:"Inspection",requestedTime:"next week"},"+15555550100","America/Indiana/Indianapolis")).toContain("not a confirmed appointment");
  });
});
