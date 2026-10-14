import { useSyncExternalStore } from "react";

import type { ChatTimeline as ChatTimelineComponent } from "./ChatTimeline.tsx";

// The chat timeline (and @legendapp/list under it) is its own chunk, out of the entry. The import
// starts as soon as this module is evaluated, so it loads beside the app's first requests;
// ChatView reads a conversation into its state only once it resolves (`loadChatTimeline`), so a
// timeline is never asked for before it exists and the list mounts with ChatView's refs bound.
type Timeline = typeof ChatTimelineComponent;

let loaded: Timeline | null = null;
let pending: Promise<Timeline> | null = null;
const listeners = new Set<() => void>();

/** Starts (or joins) the chunk's load; a failed load is forgotten so the next read tries again. */
export function loadChatTimeline(): Promise<Timeline> {
  if (loaded !== null) return Promise.resolve(loaded);
  pending ??= import("./ChatTimeline.tsx").then((module) => {
    loaded = module.ChatTimeline;
    for (const listener of listeners) listener();
    return loaded;
  }, (cause: unknown) => {
    pending = null;
    throw cause;
  });
  return pending;
}

/** The timeline component once its chunk has loaded, else null. */
export function loadedChatTimeline(): Timeline | null {
  return loaded;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The timeline component, re-rendering the caller when its chunk arrives. */
export function useChatTimeline(): Timeline | null {
  return useSyncExternalStore(subscribe, loadedChatTimeline, loadedChatTimeline);
}

// a load that fails here is retried by the first conversation read
loadChatTimeline().catch(() => undefined);
