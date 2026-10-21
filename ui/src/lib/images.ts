import { IMAGE_LIMITS, type ImageType } from "@mc/shared";
import { api } from "../api.ts";
import { seedPictureUrl } from "./pictureUrls.ts";

/** A picture picked for a message, ready to upload. `url` is a local address for showing it before (and while) it uploads. */
export type Picture = { id: string; blob: Blob; url: string; type: ImageType; name: string };

const ALLOWED = new Set<string>(IMAGE_LIMITS.types);
export const IMAGE_ACCEPT = IMAGE_LIMITS.types.join(",");

const shortName = (name: string) => (name.length > 32 ? `${name.slice(0, 31)}…` : name || "That file");

/** Size after shrinking so the long side is at most `max`, never enlarging. */
export function fitSize(width: number, height: number, max: number = IMAGE_LIMITS.maxSide): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encode(canvas: HTMLCanvasElement, type: ImageType, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Checks a file and shrinks it when it is too big to send: the long side is cut to 2000 px, and a picture that is still
 * over 5 MB is saved as a JPEG. Pictures that already fit are sent as they are (a GIF keeps its animation).
 * Throws an Error whose message is meant to be shown.
 */
export async function preparePicture(file: File): Promise<Picture> {
  const name = shortName(file.name);
  if (!ALLOWED.has(file.type)) throw new Error(`${name} is not supported. Use JPEG, PNG, WebP or GIF.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${name} could not be read as a picture.`);
  }
  try {
    const target = fitSize(bitmap.width, bitmap.height);
    const small = target.width === bitmap.width && target.height === bitmap.height;
    let blob: Blob = file;
    let type = file.type as ImageType;
    if (!small || file.size > IMAGE_LIMITS.bytes) {
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`${name} could not be shrunk.`);
      // JPEG has no transparency: paint white first so see-through areas do not turn black.
      const keepsAlpha = file.type === "image/png" || file.type === "image/webp";
      if (!keepsAlpha) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, target.width, target.height);
      }
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      // a GIF becomes a still PNG once it has to be shrunk
      const first: ImageType = file.type === "image/gif" ? "image/png" : (file.type as ImageType);
      let out = await encode(canvas, first, 0.9);
      // Some browsers cannot save WebP and silently give PNG; either way it must still fit.
      if (out && out.size > IMAGE_LIMITS.bytes) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, target.width, target.height);
        out = await encode(canvas, "image/jpeg", 0.85);
      }
      if (!out || !ALLOWED.has(out.type)) throw new Error(`${name} could not be shrunk.`);
      blob = out;
      type = out.type as ImageType;
    }
    if (blob.size > IMAGE_LIMITS.bytes) throw new Error(`${name} is still over 5 MB after shrinking. Pick a smaller picture.`);
    return { id: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), type, name };
  } finally {
    bitmap.close();
  }
}

/**
 * Uploads the pictures of a message about to be sent. Each one is shown from its local copy right away, so the message
 * does not wait on the network to look right. Throws with a message to show when one fails.
 */
export async function uploadPictures(chatId: string, pictures: Picture[]): Promise<void> {
  for (const p of pictures) seedPictureUrl(p.id, p.url);
  await Promise.all(pictures.map((p) => api.uploadImage(chatId, p.id, p.blob)));
}
