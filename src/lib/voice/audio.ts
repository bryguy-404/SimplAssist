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

/** Detect output energy, not merely a received packet (Live also emits silence).
 * A low -60 dBFS RMS threshold preserves quiet opening consonants. This is only
 * an output playback gate, never a caller speech/turn detector or proof of consent.
 */
export function hasAudibleAudio(
  bytes: Buffer,
  profile: AudioProfileName,
): boolean {
  const stride = AUDIO_PROFILES[profile].bytesPerSample;
  let squares = 0;
  for (let i = 0; i < bytes.length; i += stride) {
    let sample: number;
    if (profile === "pcm16") sample = bytes.readInt16LE(i);
    else {
      const value = ~bytes[i] & 255;
      const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
      sample = (value & 128 ? -1 : 1) * (magnitude - 132);
    }
    squares += sample * sample;
  }
  return bytes.length > 0 && squares / (bytes.length / stride) >= 32 * 32;
}

/** A shallow, paced queue: provider bursts cannot create seconds of stale speech. */
export class AudioQueue {
  private bytes: Buffer = Buffer.alloc(0);
  readonly frameBytes: number;
  constructor(
    readonly profile: AudioProfileName,
    private maxMs = 1500,
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
  get hasPendingAudibleAudio() {
    // Live continues emitting silence between spoken responses. Test each
    // paced frame so a long silent tail cannot dilute a quiet spoken frame.
    for (let offset = 0; offset < this.bytes.length; offset += this.frameBytes) {
      if (
        hasAudibleAudio(
          this.bytes.subarray(offset, offset + this.frameBytes),
          this.profile,
        )
      )
        return true;
    }
    return false;
  }
  restrictToNormalBuffer() {
    if (this.pendingMs <= 1500) this.maxMs = 1500;
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
