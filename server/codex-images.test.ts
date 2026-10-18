import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexImageParts, codexTranscriptImage } from "./codex-images.ts";
import { parseCodexTranscript } from "./codex.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
const data = `data:image/png;base64,${png.toString("base64")}`;
const event = (message: string, local_images: string[]) => ({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message, local_images } });
const response = (text: string, image: string) => ({ type: "response_item", timestamp: "2026-09-27T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: image }] } });
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

it("preserves image-only Codex turns and pairs event/response copies in either order", () => {
  for (const text of ["", "What is this?"]) {
    for (const records of [[event(text, ["/tmp/shot.png"]), response(text, data)], [response(text, data), event(text, ["/tmp/shot.png"])]]) {
      const turns = parseCodexTranscript(jsonl(...records));
      expect(turns).toHaveLength(1);
      expect(turns[0]!.parts.filter((part) => part.kind === "image")).toEqual(codexImageParts(event(text, ["/tmp/shot.png"])));
      expect(JSON.stringify(turns)).not.toContain(png.toString("base64"));
      expect(JSON.stringify(turns)).not.toContain("/tmp/shot.png");
    }
  }
  expect(parseCodexTranscript(jsonl(event("", ["one.png"]), event("", ["two.png"])))).toHaveLength(2);
  expect(parseCodexTranscript(jsonl(response("", data)))[0]?.parts).toEqual(codexImageParts(response("", data)));
});

it("strips Codex's native image envelope but keeps user-typed lookalikes", () => {
  const withEnvelope = {
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [
      { type: "input_text", text: '<image name=[Image #1] path="/tmp/yellow-star.gif">' },
      { type: "input_image", image_url: data },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "[Image #1]" },
    ] },
  };
  const regressionTurns = parseCodexTranscript(jsonl(withEnvelope));
  const regressionUser = regressionTurns[0]!;
  expect(regressionUser.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1]"]); // regression (fails on main)
  expect(regressionUser.parts.filter((part) => part.kind === "image")).toHaveLength(1); // regression (fails on main)
  expect(JSON.stringify(regressionUser)).not.toContain("/tmp/yellow-star.gif"); // regression (fails on main)

  // a pasted image's envelope has no path; two of them in one message
  const pasted = parseCodexTranscript(jsonl({
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "<image name=[Image #1]>" },
      { type: "input_image", image_url: data },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "<image name=[Image #2]>" },
      { type: "input_image", image_url: data.replace("image/png", "image/gif") },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "[Image #1] [Image #2] compare these" },
    ] },
  }))[0]!;
  expect(pasted.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1] [Image #2] compare these"]);
  expect(pasted.parts.filter((part) => part.kind === "image")).toHaveLength(2);

  const controlTurns = parseCodexTranscript(jsonl({
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: 'I typed <image name=x> and </image> literally.' }] },
  }));
  expect(controlTurns[0]?.parts.filter((part) => part.kind === "text").map((part) => part.text))
    .toEqual(['I typed <image name=x> and </image> literally.']); // control
});

it("does not turn remote URLs, unsupported data, or assistant/tool content into images", () => {
  expect(codexImageParts(event("", ["https://host/shot.png", "file:///tmp/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "bad\0.png"]))).toEqual([]);
  expect(codexImageParts({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_image", image_url: data }] } })).toEqual([]);
  expect(codexImageParts(event("", ["a.png", "a.png"]))).toHaveLength(1);
});

it("fetches only referenced raster images within the retained history and bounds local reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-images-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "shot.png"), png);
    const path = join(root, "rollout.jsonl");
    const record = event("", ["assets/shot.png"]);
    const first = `${jsonl(record)}\n`;
    writeFileSync(path, first + jsonl(response("", data)));
    const ref = codexImageParts(record)[0]!.ref;
    const inlineRef = codexImageParts(response("", data))[0]!.ref;
    const segment = { path, end: Buffer.byteLength(first) };
    const found = await codexTranscriptImage([segment], ref, root);
    expect(found?.mediaType).toBe("image/png");
    expect(Buffer.from(found!.bytes)).toEqual(png);
    expect(await codexTranscriptImage([segment], inlineRef, root)).toBeNull();
    expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(first + jsonl(response("", data))) }], inlineRef, root)).toEqual(found);
    expect(await codexTranscriptImage([segment], "../../etc/passwd", root)).toBeNull();
    expect(await codexTranscriptImage([segment], `codex-${"0".repeat(64)}`, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), "<html>not an image</html>");
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    rmSync(join(root, "assets", "shot.png"));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
