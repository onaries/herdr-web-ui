import { createContext, useCallback, useContext, useState, type ComponentProps } from "react";

/** State belongs to a logical row, not to a virtualizer container. */
export interface ChatRowMemory {
  readonly toggles: Map<string, boolean | null>;
  readonly outputs: Map<string, string>;
}

export const ChatRowMemoryContext = createContext<ChatRowMemory | null>(null);

export function useChatRowToggle(key: string, initial: boolean | null) {
  const memory = useContext(ChatRowMemoryContext);
  const [value, setValue] = useState(() => memory?.toggles.has(key) ? memory.toggles.get(key) ?? null : initial);
  const update = useCallback((next: boolean | null) => {
    memory?.toggles.set(key, next);
    setValue(next);
  }, [key, memory]);
  return [value, update] as const;
}

/** Native disclosures retain their open state when their row leaves the DOM. */
export function ChatDetails({ memoryKey, onToggle, ...props }: ComponentProps<"details"> & { memoryKey: string }) {
  const [open, setOpen] = useChatRowToggle(memoryKey, false);
  return <details {...props} open={open === true} onToggle={(event) => {
    setOpen(event.currentTarget.open);
    onToggle?.(event);
  }} />;
}
