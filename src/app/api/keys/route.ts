import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUserId } from "@/lib/auth";
import { deleteUserKey, listKeyHints, saveUserKey } from "@/lib/ai/keys";
import { isProvider, PROVIDER_IDS, ProviderError, verifyKey } from "@/lib/ai/providers";

const putBody = z.object({
  provider: z.enum(PROVIDER_IDS),
  key: z.string().trim().min(8).max(500),
});

// Keys are write-only: the API only ever returns the last four characters.

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ keys: await listKeyHints(userId) });
}

export async function PUT(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = putBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That doesn't look like an API key." }, { status: 400 });
  const { provider } = parsed.data;

  try {
    await verifyKey(provider, parsed.data.key);
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Could not check this key.";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  try {
    const hint = await saveUserKey(userId, provider, parsed.data.key);
    return NextResponse.json({ provider, hint });
  } catch {
    return NextResponse.json({ error: "Could not save the key." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const provider = new URL(request.url).searchParams.get("provider");
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  await deleteUserKey(userId, provider);
  return NextResponse.json({ ok: true });
}
