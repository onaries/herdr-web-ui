interface FrameScheduler {
  requestAnimationFrame: (callback: () => void) => unknown;
  setTimeout: (callback: () => void) => unknown;
}

const browserScheduler: FrameScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  setTimeout: (callback) => window.setTimeout(callback, 0),
};

/**
 * Disposes an xterm Terminal once callbacks it has already scheduled can finish.
 *
 * xterm 5.5's reset/viewport sync can queue a frame and a task that read the renderer's dimensions.
 * Disposal removes the renderer, so either callback can throw if it runs afterward. A frame queued
 * here runs after xterm's pending frame; the task scheduled from it runs after xterm's task. Hidden
 * tabs can delay frames while still running tasks, so there is deliberately no timer fallback.
 * Same-PC pane switches normally keep PaneTerminal mounted; PC switches, sign-out and StrictMode
 * cleanup do unmount it, which is when this deferred disposal protects the retiring instance.
 */
export function disposeAfterPendingFrame(term: { dispose: () => void }, scheduler: FrameScheduler = browserScheduler): void {
  scheduler.requestAnimationFrame(() => {
    scheduler.setTimeout(() => term.dispose());
  });
}
