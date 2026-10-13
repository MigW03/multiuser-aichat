import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { getUserKey } from "@/lib/ai/keys";
import { isProvider, listModels, ProviderError, PROVIDER_LABELS } from "@/lib/ai/providers";

// Models the caller's own key can use, straight from the provider.
export async function GET(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const provider = new URL(request.url).searchParams.get("provider");
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });

  const apiKey = await getUserKey(userId, provider);
  if (!apiKey) {
    return NextResponse.json({ error: `Add your ${PROVIDER_LABELS[provider]} API key in Settings first.` }, { status: 400 });
  }

  try {
    return NextResponse.json({ models: await listModels(provider, apiKey) });
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Could not load models.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
