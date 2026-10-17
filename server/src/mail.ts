import { env } from "./env.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Sends an invite email when Resend is configured. Returns whether an email went out; never throws. */
export async function sendInviteEmail(opts: { to: string; inviter: string; what: string; link: string; days: number }): Promise<boolean> {
  if (!env.resendApiKey || !env.mailFrom) return false;
  const inviter = opts.inviter.replace(/[\r\n]+/g, " ").slice(0, 80);
  const what = opts.what.replace(/[\r\n]+/g, " ").slice(0, 100);
  const text = `${inviter} invited you to ${what} on Multiuser Chat.\n\nOpen this link to join (it only works with this email address and expires in ${opts.days} days):\n${opts.link}\n`;
  const html = `<p>${escapeHtml(inviter)} invited you to <b>${escapeHtml(what)}</b> on Multiuser Chat.</p><p><a href="${escapeHtml(opts.link)}">Join</a></p><p style="color:#6b6f76">The link only works with this email address and expires in ${opts.days} days.</p>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.mailFrom, to: [opts.to], subject: `${inviter} invited you to ${what}`, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error("[mail] Resend returned", res.status);
    return res.ok;
  } catch (e) {
    console.error("[mail]", (e as Error).message);
    return false;
  }
}
