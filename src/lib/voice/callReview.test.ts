import { describe, expect, it } from "vitest";
import { actionReviewStatus, callReviewStatus, confirmedCallContact, type ReviewActionRow } from "./callReview";

const action = (changes: Partial<ReviewActionRow> = {}): ReviewActionRow => ({
  id: "action", business_id: "business", session_id: "call", kind: "contact", status: "succeeded",
  payload: { name: "Call name", phone: "+15555550101", email: "call@example.test" }, result: {},
  confirmed_at: "2026-09-17T12:00:00Z", created_at: "2026-09-17T11:59:00Z", revision: 2, ...changes,
});

describe("customer call evidence", () => {
  it("keeps normal hangup separate from successful outcomes", () => {
    expect(callReviewStatus("closed", "caller_hangup")).toMatchObject({ label: "Call ended", tone: "neutral" });
    expect(callReviewStatus("active", null).label).toBe("Call in progress");
    expect(callReviewStatus("closed", "technical_failure").tone).toBe("warning");
  });
  it.each([
    ["accepted", "Signup text sent"], ["delivered", "Signup text delivered"],
    ["delivery_failed", "Signup text delivery failed"], ["sending_failed", "Signup text delivery failed"],
    ["expired", "Signup text delivery failed"], ["cancelled", "Signup text delivery failed"],
  ])("labels signup %s independently of action success", (deliveryStatus, label) => {
    const result = actionReviewStatus(action({ kind: "signup", result: { providerMessageId: "provider-message", deliveryStatus, summary: "Signup completed" } }), true);
    expect(result.label).toBe(label);
    expect(result.detail).not.toContain("Signup completed");
  });
  it.each([{}, { providerMessageId: "" }, { providerMessageId: "   ", deliveryStatus: "delivered" }, { deliveryStatus: "delivered" }])("requires provider acceptance evidence before claiming a signup text was sent: %j", (result) => {
    const review = actionReviewStatus(action({ kind: "signup", result }), true);
    expect(review.label).toBe("Signup text result needs review");
    expect(review.detail).toContain("Do not repeat");
  });
  it("preserves pending, uncertain and failed results without promising completion", () => {
    expect(actionReviewStatus(action({ status: "awaiting_confirmation" }), true).label).toBe("Not confirmed");
    expect(actionReviewStatus(action({ status: "uncertain" }), true).detail).toContain("Do not repeat");
    expect(actionReviewStatus(action({ status: "failed" }), true).label).toBe("Could not complete");
  });
  it("requires a confirmed calendar record and distinguishes a request", () => {
    expect(actionReviewStatus(action({ kind: "booking" }), true).label).toBe("Booking result needs review");
    expect(actionReviewStatus(action({ kind: "booking" }), true, "confirmed").label).toBe("Appointment confirmed");
    expect(actionReviewStatus(action({ kind: "booking" }), true, "cancelled").label).toBe("Appointment cancelled");
    const request = actionReviewStatus(action({ kind: "booking_request" }), true);
    expect(request.detail).toBe("Saved for owner review; this request alone is not an appointment confirmation.");
    expect(request.detail).not.toContain("Awaiting");
  });
  it("shows confirmed call identity separately from conflicting stored identity", () => {
    expect(confirmedCallContact([action()], "business", "call", "+15555550101", {
      id: "contact", name: "Stored name", email: "stored@example.test", phone: "+15555550101",
    })).toEqual({ name: "Call name", email: "call@example.test", phone: "+15555550101", conflicts: ["name", "email"] });
  });
  it.each([
    { status: "awaiting_confirmation" }, { status: "failed" }, { status: "superseded" }, { confirmed_at: null },
    { business_id: "other" }, { session_id: "other" }, { payload: { name: "Wrong", phone: "+15555550202" } },
  ])("does not treat an unverified identity as confirmed: %j", (changes) => {
    expect(confirmedCallContact([action(changes)], "business", "call", "+15555550101", null)).toBeNull();
  });
  it("uses the latest valid details before signup without taking a later correction", () => {
    const rows = [action(), action({ revision: 4, payload: { name: "Later", phone: "+15555550101" } })];
    expect(confirmedCallContact(rows, "business", "call", "+15555550101", null, 3)?.name).toBe("Call name");
  });
});
