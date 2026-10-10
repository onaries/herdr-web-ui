/**
 * POST /api/pane/move's body, read before herdr is asked. herdr refuses a malformed destination
 * with a generic `invalid_request`, so its shape is named here as `invalid_destination` instead,
 * and only the fields herdr's PaneMoveDestination has are passed on: a tab destination gets the
 * split it needs (right) when the caller left it out, and herdr's own focus is left alone
 * unless the caller asked for it.
 */
import type { PaneMoveParams } from "../shared/herdr-api.generated.ts";
import type { MovePaneDestination } from "../shared/protocol.ts";
import { isJsonObject } from "./http.ts";

export interface MoveRequestProblem {
  code: "missing_pane_id" | "invalid_destination" | "invalid_focus";
  message: string;
}

const optionalText = (value: unknown): value is string | null | undefined => value === undefined || value === null || typeof value === "string";

/** a label-like field as herdr takes it: absent and null are the same, an empty string is kept as given */
const label = (value: string | null | undefined): { label?: string | null } => (value === undefined ? {} : { label: value });

function parseDestination(value: unknown): MovePaneDestination | string {
  if (!isJsonObject(value)) return "destination must be an object";
  switch (value["type"]) {
    case "tab": {
      const tabId = value["tab_id"];
      if (typeof tabId !== "string" || tabId.trim() === "") return "destination.tab_id is required for a tab destination";
      const split = value["split"] ?? "right";
      if (split !== "right" && split !== "down") return "destination.split must be \"right\" or \"down\"";
      const target = value["target_pane_id"];
      if (!optionalText(target)) return "destination.target_pane_id must be a string";
      const ratio = value["ratio"];
      if (ratio !== undefined && ratio !== null && (typeof ratio !== "number" || !Number.isFinite(ratio))) return "destination.ratio must be a number";
      return {
        type: "tab",
        tab_id: tabId,
        split,
        ...(target === undefined ? {} : { target_pane_id: target }),
        ...(ratio === undefined ? {} : { ratio: ratio as number | null }),
      };
    }
    case "new_tab": {
      const workspaceId = value["workspace_id"];
      if (!optionalText(workspaceId) || workspaceId?.trim() === "") return "destination.workspace_id must be a workspace id";
      if (!optionalText(value["label"])) return "destination.label must be a string";
      return { type: "new_tab", ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }), ...label(value["label"] as string | null | undefined) };
    }
    case "new_workspace": {
      if (!optionalText(value["label"])) return "destination.label must be a string";
      if (!optionalText(value["tab_label"])) return "destination.tab_label must be a string";
      const tabLabel = value["tab_label"] as string | null | undefined;
      return { type: "new_workspace", ...label(value["label"] as string | null | undefined), ...(tabLabel === undefined ? {} : { tab_label: tabLabel }) };
    }
    default:
      return "destination.type must be \"tab\", \"new_tab\" or \"new_workspace\"";
  }
}

export function parseMoveRequest(payload: Record<string, unknown>): { params: PaneMoveParams } | { problem: MoveRequestProblem } {
  const paneId = payload["pane_id"];
  if (typeof paneId !== "string" || paneId.trim() === "") return { problem: { code: "missing_pane_id", message: "pane_id is required" } };
  const destination = parseDestination(payload["destination"]);
  if (typeof destination === "string") return { problem: { code: "invalid_destination", message: destination } };
  const focus = payload["focus"];
  if (focus !== undefined && typeof focus !== "boolean") return { problem: { code: "invalid_focus", message: "focus must be a boolean" } };
  return { params: { pane_id: paneId, destination, focus: focus === true } };
}
