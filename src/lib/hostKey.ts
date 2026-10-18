/**
 * The fingerprints in ssh's host-key question, one per "<TYPE> key fingerprint is <value>." line
 * (server/ssh.ts writes one per learned key; OpenSSH's own question has the same line). Empty when
 * the text has none, and the dialog then shows the question itself.
 */
export function hostKeyFingerprints(prompt: string): string[] {
  return [...prompt.matchAll(/\bkey fingerprint is (\S+?)\.?(?=\s|$)/g)].map((match) => match[1]!);
}
