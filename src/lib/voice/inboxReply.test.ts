import { describe, expect, it } from "vitest";
import { CallerInputObservation } from "./inboxReply";

function listening(profile: "pcm16" | "pcmu8" = "pcmu8", change?: (bytes: Buffer, i: number) => number) {
  const observation = new CallerInputObservation(profile);
  for (let i = 0; i < 110; i++) {
    const bytes = profile === "pcmu8" ? Buffer.alloc(160, 255) : Buffer.alloc(640);
    const chunk = change ? change(bytes, i) : i + 1;
    observation.observe(chunk, bytes, 1000 + i * 20);
  }
  return observation;
}
describe("caller reply evidence", () => {
  it.each(["pcm16","pcmu8"] as const)("requires original continuous silent %s frames after audible playback", profile => {
    expect(listening(profile).result(false, true, 1100, 3200)).toBe("silent");
  });
  it("keeps even quiet nonzero audio, missing packets, and unfinished captures visible", () => {
    expect(listening("pcm16", (b,i) => { if (i === 17) b[0] = 1; return i+1; }).result(false,true,1100,3200)).toBe("unknown");
    expect(listening("pcmu8", (_b,i) => i === 22 ? 25 : i+1).result(false,true,1100,3200)).toBe("unknown");
    for (const [clean, heard, end] of [[false,1100,3200],[true,null,3200],[true,3000,3200],[true,1100,5000]] as const) {
      expect(listening().result(false, clean, heard, end)).toBe("unknown");
    }
    expect(new CallerInputObservation("pcmu8").result(false,true,1100,3200)).toBe("unknown");
  });
  it("preserves a spoken turn even when the rest of a call is silent or ends with an error", () => {
    expect(listening().result(true,false,null,null)).toBe("responded");
  });
});
