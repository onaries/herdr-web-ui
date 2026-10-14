import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { useLocalDay } from "../lib/localDay.ts";

/** One turn's time: day-aware text, the full date as tooltip, focusable so a keyboard reaches the tooltip.
 * The label depends only on today's date, so it follows the shared day key: past midnight this
 * re-renders on its own ("today" becomes "yesterday") while the memoized turn around it does not. */
export function TurnTime({ ts }: { ts: string | null }) {
  const t = useT();
  const today = useLocalDay();
  const stamp = formatChatTimestamp(ts, today, currentLocale(), t);
  if (stamp === null) return null;
  return <time className="chat-time" dateTime={ts ?? undefined} title={stamp.full} tabIndex={0}>{stamp.label}</time>;
}
