import { LIMITS, PROVIDER_IDS, PROVIDER_KEY_URLS, PROVIDER_LABELS, type ProviderId } from "@mc/shared";
import { ExternalLink, KeyRound, LogOut, Monitor, Moon, Palette, Sun, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { forgetModels } from "../lib/models.ts";
import { notifyChanged, useApp } from "../data.tsx";
import { setThemePref, getThemePref, type ThemePref } from "../theme.ts";
import { supabase } from "../supabase.ts";
import { Button, Dialog, ErrorLine, Field, ICON, ICON_SM, STROKE, TextInput, useToast } from "./kit.tsx";

export type SettingsTab = "account" | "key" | "appearance";

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

const TABS: { id: SettingsTab; label: string; icon: typeof User }[] = [
  { id: "account", label: "Account", icon: User },
  { id: "key", label: "AI key", icon: KeyRound },
  { id: "appearance", label: "Appearance", icon: Palette },
];

export function SettingsDialog({ initialTab = "account", onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  return (
    <Dialog onClose={onClose} width={680} label="Settings">
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings">
          <h2 className="dialog-title flush">Settings</h2>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={`settings-tab ${tab === id ? "on" : ""}`} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
              <Icon size={ICON} strokeWidth={STROKE} aria-hidden /> {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "account" && <AccountTab />}
          {tab === "key" && <KeyTab />}
          {tab === "appearance" && <AppearanceTab />}
          <div className="dialog-actions">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ account

function AccountTab() {
  const { me } = useApp();
  const toast = useToast();
  const [name, setName] = useState(me.display_name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    const v = name.trim();
    if (!v) return setNameError("Enter your name.");
    setSavingName(true);
    setNameError(null);
    const { error } = await supabase.from("profiles").update({ display_name: v }).eq("id", me.id);
    setSavingName(false);
    if (error) return setNameError("Could not save your name.");
    notifyChanged();
    toast.push("Name saved");
  }

  return (
    <div className="col" style={{ gap: 24 }}>
      <form className="col" style={{ gap: 16 }} onSubmit={saveName}>
        <Field label="Your name" htmlFor="set-name" hint="This is what other people see." error={nameError}>
          <div className="row">
            <TextInput id="set-name" value={name} maxLength={LIMITS.displayNameChars} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" busy={savingName} disabled={name.trim() === me.display_name}>
              Save
            </Button>
          </div>
        </Field>
        <Field label="Email" htmlFor="set-email">
          <TextInput id="set-email" value={me.email} disabled readOnly />
        </Field>
      </form>
      <PasswordForm />
      <div>
        <Button onClick={() => void supabase.auth.signOut()}>
          <LogOut size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Log out
        </Button>
      </div>
    </div>
  );
}

function PasswordForm() {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < LIMITS.passwordMin) return setError(`Use ${LIMITS.passwordMin} or more characters.`);
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) return setError(err.message);
    setPassword("");
    setConfirm("");
    toast.push("Password changed");
  }

  return (
    <form className="col" style={{ gap: 12 }} onSubmit={submit}>
      <div className="field-label">Change password</div>
      <TextInput type="password" aria-label="New password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="New password" />
      <TextInput type="password" aria-label="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" placeholder="Type it again" invalid={!!confirm && confirm !== password} />
      <ErrorLine>{error}</ErrorLine>
      <div>
        <Button type="submit" busy={busy} disabled={!password}>
          Change password
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ AI key

/** Saves a key for one provider. The key goes to the server, which stores it encrypted and never sends it back. */
export function KeyForm({ initialProvider, onSaved }: { initialProvider?: ProviderId; onSaved?: (provider: ProviderId) => void }) {
  const { keys, reloadKeys } = useApp();
  const toast = useToast();
  const [provider, setProvider] = useState<ProviderId>(initialProvider ?? PROVIDER_IDS[0]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = keys?.find((k) => k.provider === provider);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const apiKey = value.trim();
    if (!apiKey) return setError("Paste your key.");
    setBusy(true);
    setError(null);
    try {
      await api.saveKey(provider, apiKey);
      forgetModels(provider);
      setValue("");
      reloadKeys();
      toast.push(`${PROVIDER_LABELS[provider]} key saved`);
      onSaved?.(provider);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="col" style={{ gap: 14 }} onSubmit={submit} noValidate>
      <div className="segmented" role="radiogroup" aria-label="Provider">
        {PROVIDER_IDS.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={provider === p} className={`seg ${provider === p ? "on" : ""}`} onClick={() => setProvider(p)}>
            {PROVIDER_LABELS[p]}
          </button>
        ))}
      </div>
      <Field
        label={`${PROVIDER_LABELS[provider]} API key`}
        htmlFor="key-input"
        hint={
          <>
            Don't have one?{" "}
            <a href={PROVIDER_KEY_URLS[provider]} target="_blank" rel="noopener noreferrer">
              Create a key <ExternalLink size={11} strokeWidth={STROKE} aria-hidden />
            </a>
          </>
        }
      >
        <TextInput id="key-input" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={existing ? `Replace the saved key (…${existing.hint})` : "Paste your key"} autoComplete="off" spellCheck={false} data-autofocus />
      </Field>
      <p className="small muted">Your key is stored encrypted on the server and only used to answer your messages. It is never shown again, and nobody else in a chat can see it.</p>
      <ErrorLine>{error}</ErrorLine>
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          {existing ? "Replace key" : "Save key"}
        </Button>
      </div>
    </form>
  );
}

function KeyTab() {
  const { keys, reloadKeys } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<ProviderId | null>(null);

  async function remove(provider: ProviderId) {
    setBusy(provider);
    try {
      await api.deleteKey(provider);
      forgetModels(provider);
      reloadKeys();
      toast.push(`${PROVIDER_LABELS[provider]} key removed`);
    } catch (e) {
      toast.push(messageOf(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <p className="lead">The AI answers with your own account. Add a key from Anthropic, OpenAI or OpenRouter. Without one you can still chat with people.</p>
      {keys && keys.length > 0 && (
        <ul className="key-list">
          {keys.map((k) => (
            <li key={k.provider}>
              <KeyRound size={ICON} strokeWidth={STROKE} aria-hidden />
              <div className="grow">
                <b>{PROVIDER_LABELS[k.provider]}</b>
                <div className="small muted">Saved · ends in {k.hint}</div>
              </div>
              <Button size="sm" variant="ghost" busy={busy === k.provider} onClick={() => void remove(k.provider)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <div className="field-label" style={{ marginBottom: 10 }}>
          {keys && keys.length > 0 ? "Add or replace a key" : "Add a key"}
        </div>
        <KeyForm />
      </div>
    </div>
  );
}

export function AddKeyDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Add your AI key" onClose={onClose} width={480}>
      <p className="lead">The AI answers with your own account, so you stay in control of the cost.</p>
      <KeyForm onSaved={onClose} />
    </Dialog>
  );
}

// ------------------------------------------------------------------ appearance

const THEMES: { id: ThemePref; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

function AppearanceTab() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  return (
    <div className="col" style={{ gap: 16 }}>
      <div>
        <div className="field-label">Theme</div>
        <p className="small muted">System follows your computer and switches by itself.</p>
      </div>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {THEMES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={pref === id}
            className={`theme-option ${pref === id ? "on" : ""}`}
            onClick={() => {
              setPref(id);
              setThemePref(id);
            }}
          >
            <Icon size={20} strokeWidth={STROKE} aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
