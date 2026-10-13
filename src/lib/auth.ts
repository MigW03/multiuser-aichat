import { createClient } from "@/lib/supabase/server";

/** The signed-in user's id, or null. For route handlers, which the proxy doesn't gate. */
export async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ?? null;
}
