import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Entry } from "./model";

export interface TapeInfo {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

export type Connection = "loading" | "live" | "reconnecting" | "error";

export interface TapeData {
  info: TapeInfo | null;
  /** Append-only between resets; mutate-in-place for cheap appends, so watch `version`. */
  entries: Entry[];
  version: number;
  /** Bumped when the file was truncated/replaced and entries restarted from scratch. */
  epoch: number;
  connection: Connection;
  error?: string;
  lastUpdate: number;
}

/** The tape the page shows, from `?tape=<name>`. */
export function currentTape(): string {
  return new URLSearchParams(location.search).get("tape") ?? "";
}

export function apiUrl(path: string, params: Record<string, string | number> = {}): string {
  const q = new URLSearchParams({ tape: currentTape(), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return `${path}?${q}`;
}

/** Loads the tape snapshot, then tails it over SSE (reconnecting from the last byte offset). */
export function useTape(name: string): TapeData {
  const entries = useRef<Entry[]>([]);
  const offset = useRef(0);
  const lastId = useRef(-Infinity);
  const [state, setState] = useState<Omit<TapeData, "entries">>({
    info: null,
    version: 0,
    epoch: 0,
    connection: "loading",
    lastUpdate: 0,
  });

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const append = (batch: Entry[]) => {
      let added = 0;
      for (const e of batch) {
        if (typeof e.id === "number" && e.id <= lastId.current) continue;
        if (typeof e.id === "number") lastId.current = e.id;
        entries.current.push(e);
        added++;
      }
      return added;
    };

    const reset = () => {
      entries.current = [];
      offset.current = 0;
      lastId.current = -Infinity;
      setState((s) => ({ ...s, version: s.version + 1, epoch: s.epoch + 1 }));
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/stream?${new URLSearchParams({ tape: name, offset: String(offset.current) })}`);
      source.addEventListener("hello", (ev) => {
        const data = JSON.parse((ev as MessageEvent).data);
        setState((s) => ({ ...s, info: data.tape, connection: "live", error: undefined }));
      });
      source.addEventListener("reset", () => reset());
      source.addEventListener("entries", (ev) => {
        const data = JSON.parse((ev as MessageEvent).data);
        offset.current = data.offset;
        if (append(data.entries)) {
          setState((s) => ({
            ...s,
            info: s.info && { ...s.info, size: data.offset },
            version: s.version + 1,
            lastUpdate: Date.now(),
          }));
        }
      });
      source.onerror = () => {
        source?.close();
        if (closed) return;
        setState((s) => ({ ...s, connection: "reconnecting" }));
        retry = setTimeout(connect, 1500);
      };
    };

    (async () => {
      try {
        const res = await fetch(`/api/tape?${new URLSearchParams({ tape: name })}`);
        if (res.status === 404 || res.status === 400) {
          // Not a tape we can serve; following it would only retry forever.
          const body = await res.json().catch(() => ({}));
          setState((s) => ({ ...s, connection: "error", error: body.error ?? `tape not found: ${name}` }));
          return;
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        if (closed) return;
        append(data.entries);
        offset.current = data.offset;
        setState((s) => ({ ...s, info: data.tape, version: s.version + 1, lastUpdate: Date.now() }));
      } catch (err) {
        setState((s) => ({ ...s, connection: "error", error: String(err) }));
      }
      connect();
    })();

    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [name]);

  return { ...state, entries: entries.current };
}

/** "Now" on the tape's clock: wall time when live, the virtual playback time when replaying. */
export const NowContext = createContext<number>(Date.now());

export function useNow(): number {
  return useContext(NowContext);
}

export function useTicker(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export function usePersistent<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`walkman:${key}`);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`walkman:${key}`, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

export type TapeStatus = "running" | "recent" | "idle";

export interface TapeSummary {
  name: string;
  size: number;
  mtime: number;
  status: TapeStatus;
  /** Prompt of the latest turn (truncated). */
  prompt: string;
  last: string;
  sidecars: Array<{ name: string; size: number }>;
  /** False for a tape given on the command line from outside the tape directory. */
  deletable: boolean;
}

export interface DeleteResult {
  deleted: string[];
  errors: Record<string, string>;
}

/** Delete tapes together with their sidecars. `force` is needed for running tapes. */
export async function deleteTapes(names: string[], force: boolean): Promise<DeleteResult> {
  const res = await fetch("/api/tapes/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Walkman": "1" },
    body: JSON.stringify({ names, force }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 409) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as DeleteResult;
}

/** The tapes in Bub's tape directory, refreshed every few seconds (running ones first). */
export function useTapeList(intervalMs = 4000): { tapes: TapeSummary[] | null; directory: string; error?: string; reload: () => void } {
  const [state, setState] = useState<{ tapes: TapeSummary[] | null; directory: string; error?: string }>({ tapes: null, directory: "" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/tapes");
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        if (alive) setState({ tapes: data.tapes, directory: data.directory });
      } catch (err) {
        if (alive) setState((s) => ({ ...s, error: String(err) }));
      }
    };
    load();
    const id = setInterval(() => document.visibilityState === "visible" && load(), intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, nonce]);
  return { ...state, reload };
}
