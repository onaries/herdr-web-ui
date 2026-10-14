import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";

test("a production build produces exact compressed JS/CSS sidecars and leaves the shell alone", async () => {
  const output = mkdtempSync(join(tmpdir(), "herdr-compressed-build-"));
  try {
    await build({ root: join(import.meta.dir, ".."), logLevel: "silent", build: { outDir: output, emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: "assets/nested/[name]-[hash].js", chunkFileNames: "assets/nested/[name]-[hash].js", assetFileNames: "assets/nested/[name]-[hash][extname]" } },
    } });
    const assets = join(output, "assets");
    const names = readdirSync(assets, { recursive: true }).filter((name) => /\.(?:js|css)$/.test(name));
    expect(names.some((name) => name.endsWith(".js"))).toBe(true);
    expect(names.some((name) => name.endsWith(".css"))).toBe(true);
    for (const name of names) {
      const path = join(assets, name);
      expect(existsSync(`${path}.br`)).toBe(true);
      expect(existsSync(`${path}.gz`)).toBe(true);
      expect(brotliDecompressSync(readFileSync(`${path}.br`))).toEqual(readFileSync(path));
      expect(gunzipSync(readFileSync(`${path}.gz`))).toEqual(readFileSync(path));
    }
    expect(existsSync(join(output, "index.html.br"))).toBe(false);
    expect(existsSync(join(output, "index.html.gz"))).toBe(false);
    expect(existsSync(join(output, "sw.js.gz"))).toBe(false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
// a whole production build, beside the other unit files CI runs four at a time: it took 23 s there
}, 120_000);
