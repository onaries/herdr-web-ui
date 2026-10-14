import { X } from "lucide-react";
import type { ReactNode } from "react";

import "./ComposerNotices.css";

import { isDismissible, type ComposerNotice } from "../lib/composerNotices.ts";
import { useT } from "../lib/i18n.ts";

export interface ComposerNoticeRow extends ComposerNotice {
  /** another app holds the pane, the output stream failed: the terminal pill's warning colour */
  warning: boolean;
  mark: ReactNode;
  text: ReactNode;
  actions?: ReactNode;
}

interface ComposerNoticesProps {
  /** as arranged by lib/composerNotices.ts: the top row first */
  notices: readonly ComposerNoticeRow[];
  onDismiss: (notice: ComposerNoticeRow) => void;
}

/** The notices over the input card: a row per notice, its own way on at its end, then its dismiss (an activity has none). */
export function ComposerNotices({ notices, onDismiss }: ComposerNoticesProps) {
  const t = useT();
  return (
    <section className="composer-notices" aria-label={t("Notices")}>
      {notices.map((notice) => (
        <div key={notice.id} className={`composer-notice${notice.warning ? " is-warning" : ""}`} role="status">
          <span className="composer-notice-mark" aria-hidden="true">{notice.mark}</span>
          <span className="composer-notice-text">{notice.text}</span>
          <span className="composer-notice-actions">
            {notice.actions}
            {isDismissible(notice) && (
              <button type="button" className="composer-notice-dismiss" aria-label={t("Dismiss notice")} title={t("Dismiss notice")} onClick={() => onDismiss(notice)}>
                <X aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}
