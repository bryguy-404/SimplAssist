import { afterEach, describe, expect, it, vi } from "vitest";
import type Telnyx from "telnyx";
import { proxyVoiceRecording, trustedRecordingUrl } from "./recording";
afterEach(() => vi.unstubAllGlobals());
describe("authenticated recording proxy", () => {
  it.each([
    "http://example.com/file",
    "https://localhost/file",
    "https://127.0.0.1/file",
    "https://169.254.169.254/file",
    "https://telnyx.com.attacker.example/file",
    "https://user:password@api.telnyx.com/file",
  ])("rejects untrusted provider URL %s", (url) => {
    expect(() => trustedRecordingUrl(url)).toThrow();
  });
  it("does not fetch recording audio when its call identifiers mismatch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const telnyx = {
      recordings: {
        retrieve: vi.fn().mockResolvedValue({
          data: {
            call_control_id: "wrong",
            call_session_id: "session",
            download_urls: { mp3: "https://recordings.telnyx.com/private" },
          },
        }),
      },
    } as unknown as Telnyx;
    expect(
      (
        await proxyVoiceRecording(
          telnyx,
          "recording",
          { call_control_id: "right", call_session_id: "session" },
          null,
        )
      ).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("streams audio privately without forwarding provider credentials or exposing its URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { "content-range": "bytes 0-2/3" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const telnyx = {
      recordings: {
        retrieve: vi.fn().mockResolvedValue({
          data: {
            call_control_id: "control",
            call_session_id: "session",
            download_urls: {
              mp3: "https://recordings.telnyx.com/private?signature=SECRET",
            },
          },
        }),
      },
    } as unknown as Telnyx;
    const response = await proxyVoiceRecording(
      telnyx,
      "recording",
      { call_control_id: "control", call_session_id: "session" },
      "bytes=0-2",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Range: "bytes=0-2" },
      redirect: "error",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
