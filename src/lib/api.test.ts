import { afterEach, expect, it } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { NOTICE_VERSION } from "../../shared/telemetry.ts";
import { AttachmentTooLargeError, ApiError, changeTelemetry, fetchTelemetry, uploadPaneImage } from "./api.ts";
import { DEFAULT_SETTINGS, telemetrySettingsSnapshot } from "./settings.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

it("refuses a file over the attachment limit before any of it is sent, and sends one at the limit", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return Response.json({ ok: true, path: "/work/.herdr-web-ui/site.zip" });
  }) as typeof fetch;

  const over = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "site.zip", { type: "application/zip" });
  const refused = await uploadPaneImage("p1", over).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AttachmentTooLargeError);
  expect(refused).toMatchObject({ fileName: "site.zip", size: MAX_ATTACHMENT_BYTES + 1 });
  expect(requests).toEqual([]);

  const atLimit = new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "site.zip", { type: "application/zip" });
  expect(await uploadPaneImage("p1", atLimit)).toBe("/work/.herdr-web-ui/site.zip");
  expect(requests).toEqual(["/api/pane/image"]);
});

it("posts the full safe telemetry snapshot and current notice version", async () => {
  const settings = telemetrySettingsSnapshot({
    ...DEFAULT_SETTINGS,
    terminalFontFamily: "Private Font Name",
    chatFontFamily: "Private Chat Font",
    usageHidden: ["account-identifier"],
  });
  const change = { notice_seen: true as const, notice_version: NOTICE_VERSION, settings };
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requestUrl = url;
    requestInit = init;
    return Response.json({ enabled: true, blocked_by_env: false, notice_seen: true, next: null });
  }) as typeof fetch;

  await changeTelemetry(change);

  expect(requestUrl).toBe("/api/telemetry");
  expect(requestInit?.method).toBe("POST");
  expect(requestInit?.headers).toEqual({ "content-type": "application/json", "x-herdr-update": "1" });
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  expect(body).toEqual(change);
  expect(body).not.toHaveProperty("changed_settings");
  expect(Object.keys(body.settings as object)).toHaveLength(53);
  expect(body.settings).not.toHaveProperty("terminalFontFamily");
  expect(body.settings).not.toHaveProperty("chatFontFamily");
  expect(body.settings).not.toHaveProperty("usageHidden");
  expect((body.settings as Record<string, unknown>).terminalFontCustom).toBe(true);
  expect((body.settings as Record<string, unknown>).usageHiddenCount).toBe(1);
});

it("preserves telemetry API errors", async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ error: { code: "telemetry_failed", message: "Could not save" } }, { status: 500 })) as typeof fetch;

  const error = await changeTelemetry({ enabled: false }).catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 500, code: "telemetry_failed", detail: "Could not save" });
});

it("treats a missing telemetry route as unavailable for reads and an API error for writes", async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })) as typeof fetch;

  expect(await fetchTelemetry()).toBeNull();
  const error = await changeTelemetry({ enabled: true }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 404, code: "not_found" });
});
