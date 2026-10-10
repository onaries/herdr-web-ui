import type { PaneFindResponse } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

/** A stale native range must not be used for the user's next search. */
export function findResultAfterError(result: PaneFindResponse | null, cause: unknown): PaneFindResponse | null {
  return cause instanceof ApiError && cause.code === "stale_content" ? null : result;
}
