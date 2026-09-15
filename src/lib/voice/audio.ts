export type AudioProfileName = "pcm16" | "pcmu8";
export const AUDIO_PROFILES = {
  pcm16: {
    encoding: "L16",
    rate: 16000,
    bytesPerSample: 2,
    silence: 0,
    format: { type: "audio/pcm", rate: 16000 },
  },
  pcmu8: {
    encoding: "PCMU",
    rate: 8000,
    bytesPerSample: 1,
    silence: 255,
    format: { type: "audio/pcmu", rate: 8000 },
  },
} as const;

export function validateMediaFormat(
  profile: AudioProfileName,
  format: unknown,
): void {
  const f = format as Record<string, unknown> | null;
  const expected = AUDIO_PROFILES[profile];
  if (
    !f ||
    f.encoding !== expected.encoding ||
    f.sample_rate !== expected.rate ||
    f.channels !== 1
  ) {
    throw new Error("audio_format_mismatch");
  }
}

export function decodeAudio(value: unknown, profile: AudioProfileName): Buffer {
  if (
    typeof value !== "string" ||
    value.length > 256_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("invalid_audio_payload");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length % AUDIO_PROFILES[profile].bytesPerSample !== 0)
    throw new Error("invalid_audio_alignment");
  return bytes;
}

/** A shallow, paced queue: provider bursts cannot create seconds of stale speech. */
export class AudioQueue {
  private bytes: Buffer = Buffer.alloc(0);
  readonly frameBytes: number;
  constructor(
    readonly profile: AudioProfileName,
    private readonly maxMs = 1500,
  ) {
    const f = AUDIO_PROFILES[profile];
    this.frameBytes = (f.rate * f.bytesPerSample) / 50;
  }
  append(bytes: Buffer) {
    if (this.bytes.length + bytes.length > (this.frameBytes * this.maxMs) / 20)
      throw new Error("audio_backpressure");
    this.bytes = Buffer.concat([this.bytes, bytes]);
  }
  take(pad = false): Buffer | null {
    if (!this.bytes.length && !pad) return null;
    const frame = Buffer.alloc(
      this.frameBytes,
      AUDIO_PROFILES[this.profile].silence,
    );
    const count = Math.min(frame.length, this.bytes.length);
    this.bytes.copy(frame, 0, 0, count);
    this.bytes = this.bytes.subarray(count);
    return frame;
  }
  takeBuffered(): Buffer {
    const bytes = this.bytes;
    this.bytes = Buffer.alloc(0);
    return bytes;
  }
  clear() {
    this.bytes = Buffer.alloc(0);
  }
  get pendingMs() {
    return (this.bytes.length / this.frameBytes) * 20;
  }
}

/** Telnyx chunks are ordered per inbound track, not by arrival or global sequence. */
export class InboundReorderBuffer {
  private expected = 1;
  private chunks = new Map<number, { bytes: Buffer; receivedAt: number }>();
  add(chunk: number, bytes: Buffer, now: number) {
    if (!Number.isSafeInteger(chunk) || chunk < 1)
      throw new Error("invalid_audio_chunk");
    if (chunk < this.expected || this.chunks.has(chunk)) return;
    if (chunk - this.expected > 100 || this.chunks.size >= 50)
      throw new Error("audio_sequence_gap");
    this.chunks.set(chunk, { bytes, receivedAt: now });
  }
  drain(now: number): Buffer[] {
    const result: Buffer[] = [];
    while (this.chunks.size) {
      const next = this.chunks.get(this.expected);
      if (next) {
        result.push(next.bytes);
        this.chunks.delete(this.expected++);
        continue;
      }
      const first = Math.min(...Array.from(this.chunks.keys()));
      // A bounded jitter window prevents a lost packet from stalling a call.
      if (now - this.chunks.get(first)!.receivedAt < 60) break;
      this.expected = first;
    }
    return result;
  }
}
