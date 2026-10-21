/** The fictional sessions session-history-browser-qa.ts answers with, and the one its fixture's pane already shows; no browser or Bun globals, so both sides import it. */
import type { SessionHistoryRow } from "../shared/protocol.ts";
export const SHOWN_SESSION = "11111111-1111-4111-8111-111111111112";
export const OLDER_SESSION = "11111111-1111-4111-8111-111111111111";
export const UNVERIFIED_SESSION = "11111111-1111-4111-8111-111111111110";
const at = (minute: number) => `2026-09-25T09:${String(minute).padStart(2, "0")}:00.000Z`;
export const SESSION_ROWS: SessionHistoryRow[] = [
  { id: SHOWN_SESSION, title: "Retry budget for the payment client", firstMessage: "Cap the payment client's retries at three and log each one.", startedAt: at(4), updatedAt: at(9), resume: { argv: ["codex", "resume", SHOWN_SESSION] } },
  { id: OLDER_SESSION, title: "Flaky export test", firstMessage: "Why does the export test fail one run in ten?", startedAt: at(0), updatedAt: at(3), resume: { argv: ["codex", "resume", OLDER_SESSION] } },
  { id: UNVERIFIED_SESSION, title: null, firstMessage: "A session whose resume syntax is not verified.", startedAt: null, updatedAt: at(1), resume: null },
];
