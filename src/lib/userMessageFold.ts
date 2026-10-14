/**
 * A long user message (a pasted log, a whole file, a brief of many lines) folds behind "Show full
 * message" so the exchange around it stays in view. This rule gates the fold from the text alone:
 * only a message past it is capped and measured (ChatView.tsx), so a virtualized row never reads
 * its own height on every mount. The fold shows `USER_MESSAGE_FOLD_LINES` lines of prose
 * (ChatView.css caps the body at that many lines, the count written as `--chat-fold-lines` in
 * styles.css), so a message passes once it has more lines than the fold shows, or more characters
 * than about that many lines hold in the widest bubble (a paste with few line breaks).
 * Adapted from t3code's `shouldCollapseUserMessage` (MessagesTimeline.logic.ts, MIT).
 */

/** Lines of prose a folded message shows; the same count as `--chat-fold-lines` (styles.css). */
export const USER_MESSAGE_FOLD_LINES = 12;
/** Characters a message folds past without line breaks: about twelve lines of the widest bubble. */
export const USER_MESSAGE_FOLD_CHARS = 900;

/** A Markdown link or image: `[label](address)`, `![alt](address)`, the address possibly in `<…>`. */
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

/** The message as it is read: a link or an image counts as its label, not its address. */
export function visibleUserMessageText(text: string): string {
  return text.replace(MARKDOWN_LINK, "$1");
}

/** Whether this message is long enough to fold: more lines than the fold shows, or a long paste with few breaks. */
export function shouldFoldUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text).trim();
  if (visible.length === 0) return false;
  return visible.length > USER_MESSAGE_FOLD_CHARS || visible.split("\n").length > USER_MESSAGE_FOLD_LINES;
}
