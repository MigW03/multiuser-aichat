import { IMAGE_LIMITS, type ImageType } from "@mc/shared";
import { sniffImage } from "./image-sniff.ts";
import { admin } from "./supabase.ts";

const BUCKET = "chat-images";
const SIGNED_SECONDS = 60 * 60;
/** Uploaded but never sent. */
const WAITING_MAX_AGE_MS = 60 * 60_000;

export type StoreResult = { ok: true; id: string } | { ok: false; status: 400 | 413 | 429 | 500; error: string };

/** Checks and stores one picture a chat member uploaded. It stays unsent (message_id null) until a message claims it. */
export async function storeImage(userId: string, chatId: string, id: string, bytes: Uint8Array): Promise<StoreResult> {
  if (bytes.length === 0) return { ok: false, status: 400, error: "That file is empty." };
  if (bytes.length > IMAGE_LIMITS.bytes) return { ok: false, status: 413, error: "That picture is over 5 MB." };
  const mime = sniffImage(bytes);
  if (!mime) return { ok: false, status: 400, error: "Use a JPEG, PNG, WebP or GIF picture." };

  // A retry after a failed send uploads the same picture again: when it is already here, unsent and the sender's own, that is fine.
  const { data: existing } = await admin.from("chat_images").select("chat_id, uploader_id, message_id").eq("id", id).maybeSingle();
  if (existing) {
    if (existing.chat_id === chatId && existing.uploader_id === userId && existing.message_id === null) return { ok: true, id };
    return { ok: false, status: 400, error: "Could not save the picture. Try again." };
  }

  const { count } = await admin.from("chat_images").select("id", { count: "exact", head: true }).eq("uploader_id", userId).is("message_id", null);
  if ((count ?? 0) >= IMAGE_LIMITS.waitingPerPerson) return { ok: false, status: 429, error: "Too many pictures waiting. Send your message first." };

  const path = `${chatId}/${id}`;
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
  if (uploadError) {
    console.error(`[images] chat ${chatId}: upload failed:`, uploadError.message);
    return { ok: false, status: 500, error: "Could not save the picture. Try again." };
  }
  const { error } = await admin.from("chat_images").insert({ id, chat_id: chatId, uploader_id: userId, path, mime, bytes: bytes.length });
  if (error) {
    await admin.storage.from(BUCKET).remove([path]);
    // the id was already used (or the chat is gone)
    return { ok: false, status: 400, error: "Could not save the picture. Try again." };
  }
  return { ok: true, id };
}

/**
 * Attaches uploaded pictures to the message about to be saved, or says why it can't. Only pictures this person uploaded
 * to this chat and have not sent yet can be claimed, so one cannot be reused in a message of someone else's choosing.
 */
export async function claimImages(userId: string, chatId: string, messageId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const { data } = await admin
    .from("chat_images")
    .update({ message_id: messageId })
    .in("id", ids)
    .eq("chat_id", chatId)
    .eq("uploader_id", userId)
    .is("message_id", null)
    .select("id");
  if ((data?.length ?? 0) === ids.length) return true;
  await releaseImages(messageId);
  return false;
}

/** Puts claimed pictures back, when the message could not be saved. */
export async function releaseImages(messageId: string): Promise<void> {
  await admin.from("chat_images").update({ message_id: null }).eq("message_id", messageId);
}

/** Addresses the browser can load for pictures of this chat, valid for an hour. Ids that are not in the chat are left out. */
export async function signedUrls(chatId: string, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data } = await admin.from("chat_images").select("id, path").eq("chat_id", chatId).in("id", ids);
  const rows = (data ?? []) as { id: string; path: string }[];
  if (rows.length === 0) return {};
  const { data: signed } = await admin.storage.from(BUCKET).createSignedUrls(
    rows.map((r) => r.path),
    SIGNED_SECONDS,
  );
  const byPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const urls: Record<string, string> = {};
  for (const r of rows) {
    const url = byPath.get(r.path);
    if (url) urls[r.id] = url;
  }
  return urls;
}

export type ImageBytes = { data: Uint8Array; mediaType: ImageType };

/** The files themselves, for sending to the AI. A picture that can't be read is left out of the map. */
export async function loadImages(chatId: string, ids: string[]): Promise<Map<string, ImageBytes>> {
  const out = new Map<string, ImageBytes>();
  if (ids.length === 0) return out;
  const { data } = await admin.from("chat_images").select("id, path, mime").eq("chat_id", chatId).in("id", ids);
  await Promise.all(
    ((data ?? []) as { id: string; path: string; mime: ImageType }[]).map(async (r) => {
      const { data: blob, error } = await admin.storage.from(BUCKET).download(r.path);
      if (error || !blob) return console.error(`[images] chat ${chatId}: could not read ${r.id}`);
      out.set(r.id, { data: new Uint8Array(await blob.arrayBuffer()), mediaType: r.mime });
    }),
  );
  return out;
}

/** The files of these chats, to remove from storage once the chats are gone. Call before deleting, remove after. */
export async function imagePathsOfChats(chatIds: string[]): Promise<string[]> {
  if (chatIds.length === 0) return [];
  const { data } = await admin.from("chat_images").select("path").in("chat_id", chatIds);
  return ((data ?? []) as { path: string }[]).map((r) => r.path);
}

export async function removeImageFiles(paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (error) console.error("[images] could not remove files:", error.message);
  }
}

/** Pictures uploaded and never sent: remove the files, then the rows. */
export async function sweepUnsentImages(): Promise<void> {
  const before = new Date(Date.now() - WAITING_MAX_AGE_MS).toISOString();
  const { data } = await admin.from("chat_images").select("id, path").is("message_id", null).lt("created_at", before).limit(500);
  const rows = (data ?? []) as { id: string; path: string }[];
  if (rows.length === 0) return;
  await removeImageFiles(rows.map((r) => r.path));
  await admin.from("chat_images").delete().in("id", rows.map((r) => r.id)).is("message_id", null);
}
