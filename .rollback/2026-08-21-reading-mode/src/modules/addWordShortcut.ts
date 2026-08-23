/**
 * Add-word shortcut module.
 *
 * Lets the user press a configurable shortcut (single letter or modifier
 * combination) in the PDF reader while the translation popup / "+生词本"
 * button is visible, to add the current word to the selected wordbook.
 *
 * Key design: the shortcut handler simply calls `activeBtn.click()`, so the
 * button state transitions (+ → ✓/✗ → restore) are EXACTLY the same as a
 * manual click — no duplicated state machine.
 *
 * Reference implementation: zotero-sentence-translator
 *   - src/translate/keybinding.ts  (parseKeybinding / matchesKeybinding)
 *   - src/hooks.ts                 (isEditableEventTarget, keydown capture)
 */

import { getPref } from "../utils/prefs";

/* ----------------------------- keybinding ----------------------------- */

export interface Keybinding {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/** Parse "Ctrl+Shift+A" / "A" / "Alt+T" → Keybinding. Empty input → null. */
export function parseKeybinding(input: string): Keybinding | null {
  const parts = (input || "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key || ["Shift", "Ctrl", "Alt", "Meta"].includes(key)) return null;
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  return {
    key,
    shift: mods.has("shift"),
    ctrl: mods.has("ctrl") || mods.has("control"),
    alt: mods.has("alt") || mods.has("option"),
    meta: mods.has("meta") || mods.has("cmd") || mods.has("command"),
  };
}

/** Case-insensitive key comparison (so "A" matches KeyboardEvent.key "a"). */
export function matchesKeybinding(
  ev: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  kb: Keybinding,
): boolean {
  return (
    String(ev.key).toLowerCase() === kb.key.toLowerCase() &&
    ev.shiftKey === kb.shift &&
    ev.ctrlKey === kb.ctrl &&
    ev.altKey === kb.alt &&
    ev.metaKey === kb.meta
  );
}

/** True when the event target is an editable field (never trigger shortcuts). */
function isEditableEventTarget(target: EventTarget | null): boolean {
  const element =
    target && (target as { nodeType?: number }).nodeType === 1
      ? (target as Element)
      : null;
  return !!element?.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  );
}

/* ------------------------- active button tracking ------------------------- */

let activeBtn: HTMLButtonElement | null = null;

/** Register the currently actionable add-word button (null to clear). */
export function setActiveAddBtn(btn: HTMLButtonElement | null): void {
  activeBtn = btn;
}

/** For debugging / tests. */
export function getActiveAddBtn(): HTMLButtonElement | null {
  return activeBtn;
}

/* --------------------------- shortcut listener --------------------------- */

/**
 * Install a keydown (capture) listener on `win` that triggers the active
 * add-word button when the configured shortcut is pressed.
 * @returns cleanup function.
 */
export function installAddWordShortcut(win: Window): () => void {
  const handler = (ev: KeyboardEvent) => {
    try {
      const raw = getPref("addWordShortcut") as string;
      if (!raw) return; // empty = disabled
      const kb = parseKeybinding(raw);
      if (!kb || !matchesKeybinding(ev, kb)) return;
      if (isEditableEventTarget(ev.target)) return; // typing in inputs
      if (!activeBtn || !activeBtn.isConnected) return; // popup gone
      ev.preventDefault();
      ev.stopPropagation();
      activeBtn.click();
    } catch {
      /* never break the event chain */
    }
  };
  win.addEventListener("keydown", handler, true);
  return () => win.removeEventListener("keydown", handler, true);
}
