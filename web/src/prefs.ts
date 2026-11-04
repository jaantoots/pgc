import { createSignal } from 'solid-js';

/** Editor preferences. They belong to the browser, not the session, so they live in localStorage. */
export interface Prefs {
  /** Vim keybindings in the SQL editors. */
  vim: boolean;
  /** Treat Option (macOS) / Alt as Meta for readline-style bindings (M-b, M-f, M-d, …). */
  altMeta: boolean;
}

const KEY = 'pgc.prefs';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
// On macOS Option types characters (on many layouts it's the only way to get @, [, |, …), so it's opt-in there.
const defaults: Prefs = { vim: false, altMeta: !isMac };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // storage unavailable or corrupt: use defaults
  }
  return { ...defaults };
}

const [prefs, setPrefsSignal] = createSignal<Prefs>(load());
const listeners = new Set<(p: Prefs) => void>();

export { prefs };

export function setPrefs(patch: Partial<Prefs>) {
  const next = { ...prefs(), ...patch };
  setPrefsSignal(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // not persisted; still applies to this tab
  }
  for (const l of listeners) l(next);
}

/** Subscribe outside of Solid (the CodeMirror editors). Returns the unsubscribe function. */
export function onPrefs(l: (p: Prefs) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Keep other tabs in step.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const next = load();
    setPrefsSignal(next);
    for (const l of listeners) l(next);
  });
}
