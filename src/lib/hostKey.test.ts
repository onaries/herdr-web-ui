import { describe, expect, it } from "bun:test";
import { hostKeyFingerprints } from "./hostKey.ts";

describe("hostKeyFingerprints", () => {
  it("reads every fingerprint line of the server's question, without the full stop", () => {
    expect(hostKeyFingerprints("The authenticity of host 'devbox' can't be established.\nED25519 key fingerprint is SHA256:Qx9v2Jb0kYJm3w7s1uTzq0pXb8cLr5nHk4dE6aFyV1U.\nRSA key fingerprint is SHA256:abc+/def=.\nAre you sure you want to continue connecting (yes/no)? "))
      .toEqual(["SHA256:Qx9v2Jb0kYJm3w7s1uTzq0pXb8cLr5nHk4dE6aFyV1U", "SHA256:abc+/def="]);
  });

  it("reads OpenSSH's own question and an MD5 fingerprint", () => {
    expect(hostKeyFingerprints("The authenticity of host 'pc (10.0.0.2)' can't be established.\r\nECDSA key fingerprint is MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])?"))
      .toEqual(["MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48"]);
  });

  it("finds none in a password question", () => {
    expect(hostKeyFingerprints("user@devbox's password: ")).toEqual([]);
    expect(hostKeyFingerprints("")).toEqual([]);
  });
});
