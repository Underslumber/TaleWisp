import { useSyncExternalStore } from "react";

export type DialogueStyle = "classic" | "im";

export const DIALOGUE_STYLE_STORAGE_KEY = "worldx.dialogueStyle";
const DIALOGUE_STYLE_EVENT = "worldx:dialogue-style";

function getSnapshot(): DialogueStyle {
  try {
    return localStorage.getItem(DIALOGUE_STYLE_STORAGE_KEY) === "classic" ? "classic" : "im";
  } catch {
    return "im";
  }
}

function getServerSnapshot(): DialogueStyle {
  return "im";
}

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DIALOGUE_STYLE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(DIALOGUE_STYLE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Read the current dialogue view style, kept in sync across all consumers. */
export function useDialogueStyle(): DialogueStyle {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Persist the style and notify every consumer (this tab + other tabs). */
export function setDialogueStyle(next: DialogueStyle): void {
  try {
    localStorage.setItem(DIALOGUE_STYLE_STORAGE_KEY, next);
  } catch {
    // Ignore storage failures (private mode / disabled storage).
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DIALOGUE_STYLE_EVENT));
  }
}

/** Flip between classic and IM styles. */
export function toggleDialogueStyle(): void {
  setDialogueStyle(getSnapshot() === "im" ? "classic" : "im");
}
