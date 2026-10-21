// A person's Google profile picture is a link on Google's servers. The database only stores links of this shape; the app checks
// again before putting one in an <img>, so a wrong value in the data can never make it load from somewhere else.
const GOOGLE_PICTURE = /^https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/;

/** The link if it is a Google profile picture, otherwise null (the avatar shows initials). */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  return url && url.length <= 500 && GOOGLE_PICTURE.test(url) ? url : null;
}
