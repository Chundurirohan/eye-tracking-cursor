import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { reduce, initialContext, decideResume, type AppState, type AppEvent, type Machine } from "./machine";
import { persistence, type PersistedSession } from "./persistence";

interface SessionApi {
  state: AppState;
  context: Machine["context"];
  send: (e: AppEvent) => void;
  saved: PersistedSession | null;
  patchSaved: (p: Partial<PersistedSession>) => void;
  ready: boolean;
}

const Ctx = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [machine, dispatch] = useReducer(
    (m: Machine, e: AppEvent) => reduce(m, e),
    { state: "boot" as AppState, context: initialContext }
  );
  const [saved, setSaved] = useState<PersistedSession | null>(null);
  const [ready, setReady] = useState(false);
  const savedRef = useRef<PersistedSession | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await persistence.load();
      if (!alive) return;
      savedRef.current = s; setSaved(s);
      dispatch({ type: "BOOT_DONE", resume: decideResume(s) });
      setReady(true);
    })();
    return () => { alive = false; };
  }, []);

  const patchSaved = (p: Partial<PersistedSession>) => {
    const base = savedRef.current ?? saved ?? { version: 1 as const, permissionGranted: false, pauseOnStartup: false, calibration: null };
    const next = { ...base, ...p } as PersistedSession;
    savedRef.current = next; setSaved(next);
    void persistence.save(next);
  };

  const api = useMemo<SessionApi>(
    () => ({ state: machine.state, context: machine.context, send: dispatch, saved, patchSaved, ready }),
    [machine, saved, ready]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
