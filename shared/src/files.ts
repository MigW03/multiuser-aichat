// Rules for the shared files, used by the desktop app (what it serves) and the server (what it stores).

/** Folders that hold secrets, other people's code or build output. Matched case-insensitively on the folder name. */
const HIDDEN_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".terraform", ".venv", "venv", "__pycache__",
  ".cache", ".next", ".nuxt", ".turbo", ".parcel-cache", "dist", "build", "target", "coverage", ".idea", "pods", ".gradle", ".yarn", ".pnpm-store",
]);

/** File names that usually hold secrets. Matched case-insensitively on the file name. */
const HIDDEN_FILES: RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, ...
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|tfstate|tfvars)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^\.(npmrc|netrc|pypirc|htpasswd|dockercfg|git-credentials|pgpass|my\.cnf)$/,
  /^(secrets?|credentials?)(\.|$)/,
  /^service[-_]?account.*\.json$/,
  /^\.ds_store$/,
  /^thumbs\.db$/,
];

/** Windows ignores trailing dots and spaces in names, so ".env." opens ".env". Match on the cleaned name everywhere. */
const comparable = (name: string) => name.replace(/[. ]+$/, "").toLowerCase();

export function isHiddenName(name: string, isDir: boolean): boolean {
  const n = comparable(name);
  if (n === "") return true;
  if (isDir && HIDDEN_DIRS.has(n)) return true;
  return HIDDEN_FILES.some((re) => re.test(n));
}

/** The stored copy of a project's shared files (Cloudflare R2), so they stay available when their owner's computer is off. */
export const FILE_STORE_LIMITS = {
  /** One file. Larger ones are refused. */
  fileBytes: 25 * 1024 * 1024,
  /** Everything one project keeps stored. */
  projectBytes: 1024 * 1024 * 1024,
  /** Files one project keeps stored. */
  projectFiles: 20_000,
  /** Entries returned for one directory. */
  listEntries: 500,
  /** How long a download address works, in seconds. */
  downloadSeconds: 60,
  /** Deepest folder nesting accepted. */
  depth: 30,
} as const;

export type StoredEntry = { name: string; kind: "file" | "dir"; bytes: number; modified: string | null };
export type StoredList = { path: string; entries: StoredEntry[]; truncated: boolean };
export type StoredDownload = { url: string; bytes: number; modified: string | null; expiresInSeconds: number };
export type StoredUpload = { path: string; bytes: number };
