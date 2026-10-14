import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { t } from "./i18n.ts";

/** A remote PC's read crosses the machine proxy as well, so it gets twice the local deadline. */
export function chatReadDeadlineMs(machineId: string): number {
  return machineId === LOCAL_MACHINE ? 15_000 : 30_000;
}

/** Covers headers and body; even an implementation ignoring abort cannot hold the reader. */
export async function withChatReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(t("Chat read timed out."))); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([read(controller.signal), deadline]); }
  finally { clearTimeout(timer!); }
}
