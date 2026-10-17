/** The gitignore subset used by senpi's skill discovery, without an npm dependency. */
export class SkillIgnore {
  private readonly rules: { pattern: RegExp; negated: boolean; directory: boolean }[] = [];

  add(content: string, prefix = ""): void {
    for (let line of content.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const negated = line.startsWith("!");
      if (negated) line = line.slice(1);
      const anchored = line.startsWith("/");
      if (anchored) line = line.slice(1);
      // Only unescaped trailing spaces disappear; an escaped space remains literal.
      while (line.endsWith(" ")) {
        let slashes = 0;
        for (let i = line.length - 2; i >= 0 && line[i] === "\\"; i--) slashes++;
        if (slashes % 2) break;
        line = line.slice(0, -1);
      }
      line = prefix + line;
      const directory = line.endsWith("/");
      if (directory) line = line.slice(0, -1);
      if (!line) continue;
      const start = anchored || line.includes("/") ? "^" : "(?:^|/)";
      this.rules.push({ pattern: new RegExp(start + ignoreGlob(line) + "$", "i"), negated, directory });
    }
  }

  ignores(path: string): boolean {
    const directory = path.endsWith("/");
    const parts = path.replace(/\/$/, "").split("/");
    for (let count = 1; count <= parts.length; count++) {
      const parent = count < parts.length;
      const candidate = parts.slice(0, count).join("/");
      let ignored = false;
      for (const rule of this.rules) {
        if ((!rule.directory || parent || directory) && rule.pattern.test(candidate)) ignored = !rule.negated;
      }
      if (ignored) return true;
    }
    return false;
  }
}

function ignoreGlob(pattern: string): string {
  let result = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "\\" && i + 1 < pattern.length) {
      result += pattern.charAt(++i).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") {
      if (pattern[i + 1] === "*" && (i === 0 || pattern[i - 1] === "/") && (i + 2 === pattern.length || pattern[i + 2] === "/")) {
        i++;
        if (pattern[i + 1] === "/") { result += "(?:[^/]+/)*"; i++; }
        else result += ".*";
      } else result += "[^/]*";
    } else if (char === "?") result += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) result += "\\[";
      else {
        const body = pattern.slice(i + 1, end).replace(/^!/, "^");
        result += `(?!/)[${body}]`;
        i = end;
      }
    } else result += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return result;
}
