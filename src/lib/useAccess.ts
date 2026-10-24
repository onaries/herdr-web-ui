import { useCallback, useRef, useState } from "react";
import type { AccessRefusal, HealthAuth } from "../../shared/protocol.ts";
import { fetchBridgeHealth } from "./api.ts";
import { takePairCode } from "./phone.ts";

export function useAccessState() {
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockReason, setLockReason] = useState<AccessRefusal | null>(null);
  /** the code a scanned QR brought along (`?pair=CODE`), taken off the address at once */
  const [pairCode] = useState(() => takePairCode());
  const [auth, setAuth] = useState<HealthAuth | null>(null);
  // a token a proxy sends with every request comes back right after signing out: signing out is the proxy's
  const canSignOut = auth?.authenticated === true && (auth.via === "device" || (auth.via === "token" && auth.bearer !== true));
  // a device that is in only because nothing is paired yet still pairs from the QR code's address
  const pairedFromAddress = useRef(false);
  const readBridgeHealth = useCallback(async () => {
    try { const next = await fetchBridgeHealth(); setLocked(next.auth.required && !next.auth.authenticated); setLockReason(next.auth.reason ?? null); setAuth(next.auth); }
    catch { /* retain the gate while the connection server restarts */ }
  }, []);
  return { locked, setLocked, lockReason, setLockReason, pairCode, auth, setAuth, canSignOut, pairedFromAddress, readBridgeHealth };
}

export function useLockedRef({ locked }: { locked: boolean | null }) {
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  return { lockedRef };
}
