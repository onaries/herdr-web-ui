/**
 * The notices over the input card (Composer.tsx, `.composer-notices`): the connection and input
 * states the terminal lens says in its top-right pills (PaneTerminal.css) are gathered, under
 * the chat lens, into one column of rows over the card, each with a dismiss of its own.
 *
 * The rows stand in the order t3code's composer banner stack keeps: an activity (input the user
 * still owns) nearest the card, an urgent state behind it, a plain notice at the top. A
 * dismissal lasts while the notice stands and says the same thing; once it goes, or changes its
 * words, it is forgotten, so the next one shows again. An activity is never dismissed: it holds
 * input the user typed while offline, and its Send and Discard are the only way to deal with it.
 */

export type NoticePriority = "activity" | "urgent" | "notice";

export interface ComposerNotice {
  /** one id per state, the same across renders (a pane of its own in it: another pane's dismissals never carry over) */
  readonly id: string;
  readonly priority: NoticePriority;
  /** what the notice says: a dismissed notice comes back when this changes */
  readonly revision: string;
}

/** the revision each notice was dismissed at */
export type DismissedNotices = ReadonlyMap<string, string>;

export const NO_DISMISSALS: DismissedNotices = new Map();

/** the nearest to the card first: activity stays attached, urgency and severity order the rest behind it */
const RANK: Record<NoticePriority, number> = { activity: 0, urgent: 1, notice: 2 };

/** Whether the notice may be dismissed: an activity holds the user's input and stays. */
export function isDismissible(notice: ComposerNotice): boolean {
  return notice.priority !== "activity";
}

/**
 * The notices shown, top to bottom: the dismissed ones left out, the rest from the plain notices
 * down to the activity that stands on the card. Notices of one rank keep the order given.
 */
export function arrangeNotices<T extends ComposerNotice>(notices: readonly T[], dismissed: DismissedNotices): T[] {
  return notices
    .filter((notice) => !isDismissible(notice) || dismissed.get(notice.id) !== notice.revision)
    .sort((a, b) => RANK[b.priority] - RANK[a.priority]);
}

/** The dismissals with this notice's: it stays away while it says what it says now. */
export function dismissNotice(dismissed: DismissedNotices, notice: ComposerNotice): DismissedNotices {
  if (!isDismissible(notice)) return dismissed;
  const next = new Map(dismissed);
  next.set(notice.id, notice.revision);
  return next;
}

/**
 * The dismissals still standing: one whose notice is gone, or says something else now, is
 * forgotten. The same map comes back when nothing changed, so a render can tell.
 */
export function settleDismissed(dismissed: DismissedNotices, notices: readonly ComposerNotice[]): DismissedNotices {
  const next = new Map<string, string>();
  for (const notice of notices) {
    const revision = dismissed.get(notice.id);
    if (revision === notice.revision) next.set(notice.id, revision);
  }
  return next.size === dismissed.size ? dismissed : next;
}
