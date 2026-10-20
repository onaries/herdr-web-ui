import { afterEach, describe, expect, it } from "bun:test";
import { ApiError } from "./api.ts";
import { withChatReadDeadline } from "./chatReadDeadline.ts";
import { setCurrentLanguage, translate } from "./i18n.ts";
import { saysHerdrAway, userErrorMessage, userFailure } from "./userError.ts";

const api = (status: number, detail = "herdr said no") => new ApiError("/api/x", status, detail, null);

describe("userErrorMessage", () => {
  afterEach(() => setCurrentLanguage("en"));

  it("tells a signed-out browser to pair again", () => {
    for (const status of [401, 403]) expect(userErrorMessage(api(status))).toEqual({ message: "This browser is not signed in to this PC any more. Pair it again in Settings → Phone & devices.", detail: "herdr said no" });
  });

  it("says a missing item is gone", () => {
    expect(userErrorMessage(api(404)).message).toBe("That item no longer exists on the PC. Refresh and try again.");
  });

  it("says a conflicting change happened on the PC", () => {
    expect(userErrorMessage(api(409)).message).toBe("It changed on the PC while you were acting. Check it and try again.");
  });

  it("says the PC was too slow, for 408, 504 and an aborted or timed-out request", () => {
    const slow = "The PC took too long to answer. Try again.";
    expect(userErrorMessage(api(408)).message).toBe(slow);
    expect(userErrorMessage(api(504)).message).toBe(slow);
    expect(userErrorMessage(new DOMException("The operation was aborted.", "AbortError")).message).toBe(slow);
    expect(userErrorMessage(new DOMException("signal timed out", "TimeoutError")).message).toBe(slow);
  });

  it("says the PC was too slow when the chat read misses its own deadline", async () => {
    const missed = await withChatReadDeadline(() => new Promise<never>(() => {}), 0).then(() => null, (cause: unknown) => cause);
    expect(userErrorMessage(missed)).toEqual({ message: "The PC took too long to answer. Try again.", detail: "Chat read timed out." });
  });

  it("says the PC could not do it for any other 5xx", () => {
    expect(userErrorMessage(api(500))).toEqual({ message: "The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.", detail: "herdr said no" });
    expect(userErrorMessage(api(502)).message).toBe("The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.");
  });

  it("names the next step when the server's code says its state folder refused the save", () => {
    const refused = new ApiError("/api/preferences", 500, "EACCES: permission denied, open '/state/preferences.json.7.tmp'", "preferences_unwritable");
    expect(userErrorMessage(refused)).toEqual({ message: "The server cannot save settings: check that its state folder is writable.", detail: "EACCES: permission denied, open '/state/preferences.json.7.tmp'" });
  });

  it("ignores inherited object keys when looking up a server error code", () => {
    for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(userErrorMessage(new ApiError("/api/x", 500, "herdr said no", code))).toEqual(userErrorMessage(api(500)));
    }
  });

  it("says the PC cannot be reached when fetch never got an answer", () => {
    for (const words of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(userErrorMessage(new TypeError(words))).toEqual({ message: "Can't reach the PC. Check your connection, then try again.", detail: words });
    }
  });

  it("falls back to a generic sentence for anything else, keeping its words", () => {
    const generic = "Something went wrong. Try again.";
    expect(userErrorMessage(new TypeError("x is not a function"))).toEqual({ message: generic, detail: "x is not a function" });
    expect(userErrorMessage(api(400, "label too long"))).toEqual({ message: generic, detail: "label too long" });
    expect(userErrorMessage("plain string")).toEqual({ message: generic, detail: "plain string" });
  });

  it("leaves out a detail that is empty or the sentence itself", () => {
    expect(userErrorMessage(new Error("")).detail).toBeNull();
    expect(userErrorMessage(new Error("Something went wrong. Try again.")).detail).toBeNull();
  });

  it("answers in the UI language", () => {
    setCurrentLanguage("ko");
    expect(userErrorMessage(new TypeError("Failed to fetch")).message).toBe(translate("ko", "Can't reach the PC. Check your connection, then try again."));
    expect(userErrorMessage(new TypeError("Failed to fetch")).message).not.toBe("Can't reach the PC. Check your connection, then try again.");
  });
});

describe("saysHerdrAway", () => {
  it("reads the server's words for a herdr it could not reach, and no other failure", () => {
    expect(saysHerdrAway("cannot reach herdr at /tmp/x/herdr.sock: connect ENOENT /tmp/x/herdr.sock")).toBe(true);
    expect(saysHerdrAway("Disabled in herdr")).toBe(false);
  });
});

describe("userFailure", () => {
  afterEach(() => setCurrentLanguage("en"));

  it("names the cause the status gives, with the advice beyond trying again folded beside it", () => {
    expect(userFailure(api(401))).toEqual({ kind: "signed-out", cause: "Not signed in to this PC", advice: "Pair it again in Settings → Phone & devices.", detail: "herdr said no" });
    expect(userFailure(api(404))).toEqual({ kind: "gone", cause: "It no longer exists on the PC", advice: "Refresh and try again.", detail: "herdr said no" });
    expect(userFailure(api(409))).toEqual({ kind: "changed", cause: "It changed on the PC", advice: "Check it and try again.", detail: "herdr said no" });
    expect(userFailure(new TypeError("Failed to fetch"))).toEqual({ kind: "unreachable", cause: "Can't reach the PC", advice: "Check your connection, then try again.", detail: "Failed to fetch" });
  });

  it("reads a timeout as slow, with trying again as the only advice", async () => {
    for (const cause of [api(408), api(504), new DOMException("signal timed out", "TimeoutError")]) expect(userFailure(cause)).toMatchObject({ kind: "slow", cause: "The PC took too long", advice: null });
    const missed = await withChatReadDeadline(() => new Promise<never>(() => {}), 0).then(() => null, (cause: unknown) => cause);
    expect(userFailure(missed)).toEqual({ kind: "slow", cause: "The PC took too long", advice: null, detail: "Chat read timed out." });
  });

  it("takes the cause from the server's own words when they name one, keeping the words", () => {
    expect(userFailure(api(500, "disk full"))).toEqual({ kind: "refused", cause: "PC disk is full", advice: "Try again; if it keeps failing, restart Ovis on the PC.", detail: "disk full" });
    expect(userFailure(api(500, "ENOSPC: no space left on device, write")).cause).toBe("PC disk is full");
    expect(userFailure(api(500, "EACCES: permission denied, open '/x'")).cause).toBe("No permission on the PC");
    expect(userFailure(new Error("EPERM: operation not permitted")).cause).toBe("No permission on the PC");
  });

  it("knows no cause for any other 5xx or anything else, so the surface offers Try again", () => {
    expect(userFailure(api(500))).toEqual({ kind: "refused", cause: null, advice: "Try again; if it keeps failing, restart Ovis on the PC.", detail: "herdr said no" });
    expect(userFailure(api(400, "label too long"))).toEqual({ kind: "unknown", cause: null, advice: null, detail: "label too long" });
    expect(userFailure("plain string")).toEqual({ kind: "unknown", cause: null, advice: null, detail: "plain string" });
    expect(userFailure(new Error("  ")).detail).toBeNull();
  });

  it("answers in the UI language", () => {
    setCurrentLanguage("ko");
    expect(userFailure(api(500, "disk full")).cause).toBe(translate("ko", "PC disk is full"));
    expect(userFailure(api(500, "disk full")).cause).not.toBe("PC disk is full");
  });
});
