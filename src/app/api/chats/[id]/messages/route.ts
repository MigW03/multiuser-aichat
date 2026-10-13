import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { listKeyHints } from "@/lib/ai/keys";
import { PROVIDER_IDS, PROVIDER_LABELS } from "@/lib/ai/providers";
import { processChatQueue } from "@/lib/ai/run-queue";

export const maxDuration = 300;

const body = z.object({
  id: z.uuid().optional(), // chosen by the client so its optimistic copy matches the saved row
  content: z.string().trim().min(1).max(8000),
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1).max(200),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid message" }, { status: 400 });

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // The AI answers each person's messages with their own key, so refuse early if they have none for this provider.
  const { provider, model } = parsed.data;
  if (!(await listKeyHints(userId)).some((k) => k.provider === provider)) {
    return NextResponse.json(
      { error: `Add your ${PROVIDER_LABELS[provider]} API key in Settings to use it.` },
      { status: 400 },
    );
  }

  // RLS only allows this insert for chat members, as themselves, with status 'pending'.
  const { data: message, error } = await supabase
    .from("messages")
    .insert({ ...(parsed.data.id && { id: parsed.data.id }), chat_id: id, author_id: userId, role: "user", status: "pending", content: parsed.data.content, provider, model })
    .select("id")
    .single();
  if (error || !message) return NextResponse.json({ error: "Could not send message" }, { status: 403 });

  after(() => processChatQueue(id));
  return NextResponse.json({ id: message.id });
}
