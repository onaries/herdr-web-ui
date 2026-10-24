/**
 * herdr's `[ui] copy_on_select` on the PC serving this page (GET /api/herdr-ui), which a drag in the
 * terminal follows as herdr's own TUI does (#1559), for local and remote panes alike. Until a read
 * answers, letting go of a drag copies nothing: copying that was turned off must not happen once.
 * A failed read is tried again on the next terminal mount, when the browser comes back online and
 * on the first frame after a reconnect. Only an older server, which has no such route (404
 * not_found), stands for herdr's default (on).
 */
let known: boolean | null = null;
let loading: Promise<void> | null = null;

/** Whether letting go of a drag copies: herdr's copy_on_select, off until it is known. */
export function copyOnSelect(): boolean {
  return known === true;
}

export function herdrUiKnown(): boolean {
  return known !== null;
}

/** Reads the preference again (a terminal mount picks up an edited config); one read at a time. */
export function loadHerdrUi(read: typeof fetch = fetch): Promise<void> {
  loading ??= (async () => {
    try {
      const response = await read("/api/herdr-ui", { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const value = typeof body === "object" && body !== null ? (body as { copy_on_select?: unknown }).copy_on_select : undefined;
        if (typeof value === "boolean") known = value;
      } else if (response.status === 404 && (body as { error?: { code?: unknown } } | null)?.error?.code === "not_found") {
        known = true;
      }
    } catch { /* offline or refused: copying stays as it was, and a later read tries again */ }
    finally { loading = null; }
  })();
  return loading;
}

/** For tests: forget what was read. */
export function forgetHerdrUi(): void {
  known = null;
  loading = null;
}
