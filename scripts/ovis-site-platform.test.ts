import { describe, expect, it } from "bun:test";
import { downloadPlatform } from "../ovis-site/assets/platform.js";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  chromeOS: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("downloadPlatform", () => {
  it("reads navigator.userAgentData.platform first", () => {
    expect(downloadPlatform({ userAgentData: { platform: "macOS" }, userAgent: UA.windows })).toBe("mac");
    expect(downloadPlatform({ userAgentData: { platform: "Windows" }, userAgent: UA.linux })).toBe("windows");
    expect(downloadPlatform({ userAgentData: { platform: "Linux" }, userAgent: UA.windows })).toBe("linux");
    expect(downloadPlatform({ userAgentData: { platform: "Android" }, userAgent: UA.linux })).toBe("android");
  });

  it("falls back to the userAgent when the hint is missing, empty or unknown", () => {
    expect(downloadPlatform({ userAgent: UA.mac })).toBe("mac");
    expect(downloadPlatform({ userAgent: UA.iphone })).toBe("ios");
    expect(downloadPlatform({ userAgent: UA.ipad })).toBe("ios");
    expect(downloadPlatform({ userAgentData: { platform: "" }, userAgent: UA.windows })).toBe("windows");
    expect(downloadPlatform({ userAgentData: { platform: "Unknown" }, userAgent: UA.firefoxLinux })).toBe("linux");
    expect(downloadPlatform({ userAgent: UA.android })).toBe("android");
  });

  it("takes a Mac with a touch screen for an iPad asking for the desktop site", () => {
    expect(downloadPlatform({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe("ios");
    expect(downloadPlatform({ userAgentData: { platform: "macOS" }, maxTouchPoints: 5 })).toBe("ios");
    expect(downloadPlatform({ userAgent: UA.mac, maxTouchPoints: 0 })).toBe("mac");
  });

  it("says unknown when nothing names a platform it has an icon for", () => {
    expect(downloadPlatform({})).toBe("unknown");
    expect(downloadPlatform({ userAgent: "curl/8.5.0" })).toBe("unknown");
    expect(downloadPlatform({ userAgentData: { platform: "Chrome OS" }, userAgent: UA.chromeOS })).toBe("unknown");
  });
});
