import { AUDIO_PROFILES, type AudioProfileName } from "./audio";

export type VoiceInboxReply = "responded" | "silent" | "unknown";

/** Inspect original inbound frames only. The bridge also generates silence to pace its
 * provider connection, which cannot establish that the phone was actually listening. */
export class CallerInputObservation {
  private nextChunk = 1;
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private durationMs = 0;
  private continuousSilence = true;

  constructor(private readonly profile: AudioProfileName) {}

  observe(chunk: number, bytes: Buffer, now: number) {
    if (!this.continuousSilence) return;
    const validSilence = this.profile === "pcmu8"
      ? bytes.every(sample => sample === 0xff || sample === 0x7f)
      : bytes.every(sample => sample === 0);
    if (!validSilence || !bytes.length || chunk !== this.nextChunk || (this.lastAt !== null && now - this.lastAt > 500)) {
      this.continuousSilence = false;
      return;
    }
    this.nextChunk++;
    this.firstAt ??= now;
    this.lastAt = now;
    const format = AUDIO_PROFILES[this.profile];
    this.durationMs += bytes.length * 1000 / (format.rate * format.bytesPerSample);
  }

  result(spoke: boolean, cleanEnd: boolean, heardAt: number | null, endedAt: number | null): VoiceInboxReply {
    if (spoke) return "responded";
    if (!cleanEnd || !this.continuousSilence || heardAt === null || endedAt === null ||
        this.firstAt === null || this.lastAt === null || this.firstAt > heardAt ||
        endedAt - heardAt < 1000 || endedAt - this.lastAt > 250 ||
        this.durationMs < endedAt - this.firstAt - 100) return "unknown";
    return "silent";
  }
}
