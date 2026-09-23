import 'server-only';

/** Preserve the exact decoded payload for signed JSON webhooks, with a hard byte bound. */
export async function readBoundedJsonBody(request: Request, maxBytes: number): Promise<string | null> {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const encoding = request.headers.get('content-encoding');
  const declared = request.headers.get('content-length');
  if (type !== 'application/json' || (encoding && encoding.toLowerCase() !== 'identity') ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return size ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
