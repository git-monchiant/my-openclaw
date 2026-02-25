/**
 * Media Download — ดาวน์โหลด media จาก LINE + detect content type
 * Pattern จาก OpenClaw: src/line/download.ts
 */

import { messagingApi } from "@line/bot-sdk";

export interface MediaData {
  buffer: Buffer;
  mimeType: string;
  size: number;
}

/**
 * ดาวน์โหลด media จาก LINE (image, video, audio, file)
 * ใช้ MessagingApiBlobClient.getMessageContent() stream เป็น Buffer
 */
export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024, // 10MB
  mimeTypeHint?: string,
): Promise<MediaData> {
  const client = new messagingApi.MessagingApiBlobClient({ channelAccessToken });

  let response: AsyncIterable<Buffer>;
  try {
    response = await client.getMessageContent(messageId) as AsyncIterable<Buffer>;
  } catch (err: any) {
    throw new Error(`Failed to start media download: ${err?.message || err}`);
  }

  const chunks: Buffer[] = [];
  let totalSize = 0;

  try {
    for await (const chunk of response) {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        // Try to destroy the stream to free resources
        if (typeof (response as any).destroy === "function") (response as any).destroy();
        throw new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
      }
      chunks.push(chunk);
    }
  } catch (err: any) {
    // Re-throw size limit errors as-is
    if (err?.message?.includes("MB limit")) throw err;
    // Wrap stream/socket errors with context
    throw new Error(`Media download interrupted after ${Math.round(totalSize / 1024)}KB: ${err?.message || err}`);
  }

  const buffer = Buffer.concat(chunks);
  const mimeType = mimeTypeHint || detectContentType(buffer);

  return { buffer, mimeType, size: buffer.length };
}

/**
 * Detect content type จาก magic bytes (เหมือน OpenClaw)
 */
export function detectContentType(buffer: Buffer): string {
  if (buffer.length < 12) return "application/octet-stream";

  // JPEG: 0xFF 0xD8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";

  // PNG: 0x89 0x50 0x4E 0x47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";

  // GIF: 0x47 0x49 0x46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";

  // WebP: RIFF...WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";

  // MP4: ftyp at byte 4
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return "video/mp4";

  // M4A/AAC audio
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x00 &&
      buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return "audio/mp4";

  return "application/octet-stream";
}
