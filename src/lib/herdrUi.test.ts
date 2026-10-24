import { afterEach, describe, expect, it } from "bun:test";
import { copyOnSelect, forgetHerdrUi, herdrUiKnown, loadHerdrUi } from "./herdrUi.ts";

const answer = (status: number, body: unknown): typeof fetch => (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("herdr's copy_on_select in the browser", () => {
  afterEach(forgetHerdrUi);

  it("copies nothing until the server answers, then follows its answer", async () => {
    expect(copyOnSelect()).toBe(false);
    await loadHerdrUi(answer(200, { copy_on_select: true }));
    expect(copyOnSelect()).toBe(true);
    await loadHerdrUi(answer(200, { copy_on_select: false }));
    expect(copyOnSelect()).toBe(false);
  });

  it("takes herdr's default only from an older server that has no such route", async () => {
    await loadHerdrUi(answer(404, { error: { code: "not_found", message: "unknown endpoint /api/herdr-ui" } }));
    expect(copyOnSelect()).toBe(true);
  });

  it("keeps copying off and the preference unknown when the read fails, so it is tried again", async () => {
    await loadHerdrUi(answer(500, { error: { code: "internal" } }));
    await loadHerdrUi(answer(401, { error: { code: "token_required" } }));
    await loadHerdrUi(answer(200, { copy_on_select: "false" }));
    await loadHerdrUi((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch);
    expect([copyOnSelect(), herdrUiKnown()]).toEqual([false, false]);
  });

  it("keeps what it read when a later read fails", async () => {
    await loadHerdrUi(answer(200, { copy_on_select: true }));
    await loadHerdrUi(answer(500, {}));
    expect(copyOnSelect()).toBe(true);
  });

  it("asks once while a read is on its way", async () => {
    let reads = 0;
    let release!: () => void;
    const slow = (async () => { reads++; await new Promise<void>((resolve) => { release = resolve; }); return Response.json({ copy_on_select: true }); }) as unknown as typeof fetch;
    const first = loadHerdrUi(slow);
    const second = loadHerdrUi(slow);
    release();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
    expect(copyOnSelect()).toBe(true);
  });
});
