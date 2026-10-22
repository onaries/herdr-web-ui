import { describe, expect, it } from "bun:test";
import { adoptLegacyEnv, mergeEnvLayers, ovisName } from "./legacy-env.ts";

describe("settings under their names from before the rename", () => {
  it("fill an unset OVIS_* variable", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", HERDR_WEB_UI_REF: "v1.2.3", HERDR_SOCKET: "/s" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("old");
    expect(env["OVIS_REF"]).toBe("v1.2.3");
    // herdr's own variables are not the app's
    expect(Object.keys(env).filter((name) => name.startsWith("OVIS_")).sort()).toEqual(["OVIS_REF", "OVIS_TOKEN"]);
  });

  it("never override a variable set under the new name", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", OVIS_TOKEN: "new" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("new");
  });

  it("map only the app's own prefix", () => {
    expect(ovisName("HERDR_WEB_STATE_DIR")).toBe("OVIS_STATE_DIR");
    expect(ovisName("HERDR_TEST_SESSION")).toBeNull();
  });

  it("let a settings file's old name win over the parent's, as the file always did", () => {
    // herdr started the plugin with the token it was given first; the user then changed it in the plugin's env file
    const merged = mergeEnvLayers([{ HERDR_WEB_TOKEN: "first" }, { HERDR_WEB_TOKEN: "changed" }]);
    expect(merged["OVIS_TOKEN"]).toBe("changed");
    expect(mergeEnvLayers([{ OVIS_TOKEN: "parent" }, { HERDR_WEB_TOKEN: "file" }])["OVIS_TOKEN"]).toBe("file");
    expect(mergeEnvLayers([{ HERDR_WEB_TOKEN: "parent" }, { OVIS_TOKEN: "file" }])["OVIS_TOKEN"]).toBe("file");
  });
});
