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
 * Checks a file and shrinks it to save storage: the long side is cut to 1280 px and the picture is saved as WebP at
 * quality 80 (JPEG where the browser cannot save WebP). The original is kept when that would not make it smaller.
 * A GIF that already fits is sent as it is, so it keeps its animation; a bigger one becomes a still picture.
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
    const resized = target.width !== bitmap.width || target.height !== bitmap.height;
    let blob: Blob = file;
    let type = file.type as ImageType;
    if (resized || file.type !== "image/gif") {
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`${name} could not be shrunk.`);
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      let out = await encode(canvas, "image/webp", IMAGE_LIMITS.quality);
      // Some browsers cannot save WebP and silently give PNG. JPEG has no transparency: paint white behind the picture.
      if (!out || out.type !== "image/webp") {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, target.width, target.height);
        out = await encode(canvas, "image/jpeg", IMAGE_LIMITS.quality);
      }
      if (!out || !ALLOWED.has(out.type)) throw new Error(`${name} could not be shrunk.`);
      // A small file that was already well packed can grow when saved again: keep the original then.
      if (resized || out.size < file.size) {
        blob = out;
        type = out.type as ImageType;
      }
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
