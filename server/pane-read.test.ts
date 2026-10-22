import { afterEach, beforeEach, expect, it, spyOn, type Mock } from "bun:test";
import * as client from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import type { PaneReadResult } from "../shared/protocol.ts";

const UINT32_MAX = 4294967295;
const answer: PaneReadResult = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: "visible", format: "text", text: "", revision: 0, truncated: false };
let read: Mock<typeof client.paneRead>;

beforeEach(() => { read = spyOn(client, "paneRead").mockResolvedValue(answer); });
afterEach(() => { read.mockRestore(); });

const get = async (query: string) => {
  const url = new URL(`http://127.0.0.1/api/pane/read?${query}`);
  return (await handlePaneRequest(new Request(url), url, "/api/pane/read", {}))!;
};

it("forwards omitted zero and uint32 boundary counts unchanged", async () => {
  const cases: [string, number | undefined][] = [["", undefined], ["&lines=0", 0], ["&lines=1", 1], ["&lines=1000", 1000], ["&lines=007", 7], [`&lines=${UINT32_MAX}`, UINT32_MAX], [`&lines=000${UINT32_MAX}`, UINT32_MAX]];
  for (const [suffix, lines] of cases) {
    read.mockClear();
    const response = await get(`pane_id=w1:p1${suffix}`);
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    const options = read.mock.calls[0]![0];
    expect(options.lines).toBe(lines);
    expect("lines" in options).toBe(lines !== undefined);
    expect(options.source).toBe("visible");
    expect(options.format).toBe("text");
  }
});

it("refuses invalid lines before any pane read", async () => {
  // Number() reads each of these as an integer from 0 to 4294967295 (the first two by rounding), so only the raw text can refuse them
  const nearMisses = ["0.99999999999999999", "4294967294.99999999999", "1.0", "1e3", "%2B5", "%205", "5%0A", "0x10", "0b1"];
  const values = ["", "%20%20", "-1", "0.5", "NaN", "Infinity", "-Infinity", String(UINT32_MAX + 1), "9007199254740993", "abc", ...nearMisses];
  for (const pane of ["w1:p1", "w9999:p9999"]) {
    for (const value of values) {
      const response = await get(`pane_id=${pane}&lines=${value}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_lines");
    }
  }
  expect(read).not.toHaveBeenCalled();
});

it("keeps refusing an unknown source or format without a read", async () => {
  for (const [query, code] of [["source=everything", "invalid_source"], ["format=html", "invalid_format"]] as const) {
    const response = await get(`pane_id=w1:p1&lines=10&${query}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
  }
  expect(read).not.toHaveBeenCalled();
});
