/**
 * OpenCode 1.17.15's recorded command expansion: body, base directory, fixed relative-path
 * sentence, then arguments. An incomplete scaffold remains raw; no filesystem path is followed.
 */
export function opencodeSkillInvocation(prompt: string): string {
  const match = /^[\s\S]*\n\nBase directory for this skill: ([^\r\n]+)\r?\nRelative paths in this skill \(e\.g\., scripts\/, references\/\) are relative to this base directory\.\r?\n\r?\n([\s\S]*)$/.exec(prompt);
  if (!match) return prompt;
  const name = match[1]?.replace(/\\/g, "/").split("/").at(-1);
  if (!name || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return prompt;
  const args = match[2] ?? "";
  return `/${name}${args ? ` ${args}` : ""}`;
}
