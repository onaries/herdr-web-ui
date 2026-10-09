/**
 * The alert sound: a short chime the open tab plays itself when an alert is due. It is page
 * audio, not a system notification, so it is heard where notifications stay quiet - a macOS
 * Focus, Do Not Disturb - as long as a tab of the app is open.
 *
 * A browser lets a page play audio only after the user interacted with it, so the audio context
 * is made and resumed from a tap or key (`unlockAlertSound`); until then a chime is skipped,
 * never queued to sound late.
 *
 * One chime sounds at a time in a tab. Alerts that come together - several panes finishing at
 * once - would otherwise sound over each other. An alert that comes while a chime sounds is
 * already told by it, except a question after a finish: the question's chime starts where the
 * finish's ends, so a question is never lost. `alertTurns.ts` coordinates eligible tabs by
 * machine, pane and kind. An alert deferred to another tab stays pending until that tab
 * confirms it chimed, or a local deadline/withdrawal lets this tab tell it instead.
 */

export type AlertSoundKind = "blocked" | "done";

/** Each chime's notes in Hz: a question rises, a finish falls. */
export const CHIME_NOTES: Readonly<Record<AlertSoundKind, readonly number[]>> = {
  blocked: [660, 880],
  done: [880, 660],
};
const NOTE_GAP_S = 0.16;
const NOTE_LENGTH_S = 0.3;
const PEAK_GAIN = 0.25;

let context: AudioContext | null = null;
// this tab's chimes that have not ended, on its context's clock: when the last of them ends,
// and when the last question's does (a preview queued behind a question does not move that)
let sounding: { audio: AudioContext; until: number; question: number; questionStart: number } | null = null;

function contextClass(): typeof AudioContext | undefined {
  return globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/** From a user gesture: lets this tab's later chimes play. Resolves whether it can play now. */
export async function unlockAlertSound(): Promise<boolean> {
  const Context = contextClass();
  if (!Context) return false;
  // a context the browser closed never resumes: the next gesture makes a new one
  if (!context || context.state === "closed") context = new Context();
  // suspended before the first gesture, or "interrupted" (iOS Safari, after a call or a switch away):
  // both resume from a gesture
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      return false;
    }
  }
  return context.state === "running";
}

export function canPlayAlertSound(): boolean {
  return context?.state === "running";
}

/** Confirms only audio that started, not a question scheduled behind a finish or preview. */
export function playAlertSound(kind: AlertSoundKind): boolean | Promise<boolean> {
  const audio = context;
  if (audio?.state !== "running") return false;
  const start = chime(audio, kind);
  if (start <= audio.currentTime) return true;
  return new Promise((resolve) => {
    const check = () => {
      if (audio.state !== "running" || context !== audio) { resolve(false); return; }
      const remaining = start - audio.currentTime;
      if (remaining <= 0) resolve(true);
      else setTimeout(check, Math.ceil(remaining * 1_000));
    };
    check();
  });
}

/** Settings' preview of the chime: always played, after a chime of this tab that still sounds. */
export function previewAlertSound(): void {
  const audio = context;
  if (audio?.state === "running") chime(audio, "done", true);
}

/** Plays `kind` unless this tab's last chime still sounds; a preview then starts where it ends. */
function chime(audio: AudioContext, kind: AlertSoundKind, preview = false): number {
  const now = audio.currentTime;
  const current = sounding !== null && sounding.audio === audio && sounding.until > now ? sounding : null;
  // already told by a chime that sounds or waits its turn: a finish by any, a question by a question's
  if (current && !preview && (kind === "done" || current.question > now)) return kind === "blocked" ? Math.max(now, current.questionStart) : now;
  const start = current ? current.until : now;
  const notes = CHIME_NOTES[kind];
  notes.forEach((frequency, index) => {
    const at = start + index * NOTE_GAP_S;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    // a ramp from near silence on both ends: a note that starts or stops at full level clicks
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LENGTH_S);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + NOTE_LENGTH_S);
  });
  const until = start + (notes.length - 1) * NOTE_GAP_S + NOTE_LENGTH_S;
  sounding = {
    audio, until,
    question: kind === "blocked" && !preview ? until : current?.question ?? 0,
    questionStart: kind === "blocked" && !preview ? start : current?.questionStart ?? 0,
  };
  return start;
}
