import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ItemDetail, TurnList, type Focus, type ViewOptions } from "./components/Timeline";
import { AnchorPicker, CheckField, Segmented, SettingsPopover, SpeedSelect } from "./components/controls";
import { Toggle } from "@base-ui/react/toggle";
import { SearchPanel } from "./components/Search";
import { Brand, TapeCrumbs } from "./components/Tapes";
import { ArrowDown, ChevronLeft, ChevronRight, Pause, Play, Search as SearchIcon, SkipEnd, SkipStart } from "./components/icons";
import { bytes, clock, duration, timeOfDay, tokens } from "./format";
import { NowContext, usePersistent, useTape, useTicker } from "./hooks";
import {
  SearchIndex,
  Timeline,
  countAt,
  listAnchors,
  parseDate,
  playbackTimes,
  searchTerms,
  type AnchorRef,
  type Entry,
  type Item,
  type SearchHit,
  type SearchKind,
  type Turn,
} from "./model";

type Mode = "live" | "replay";

const IDLE_CAP = 2000;
const SPEEDS = [1, 2, 4, 8, 16, 32, 100];
const DEFAULT_OPTS: ViewOptions = { system: false, reasoning: true, events: false, expandTools: false };

function eventName(e: Entry | undefined): string {
  return e?.kind === "event" ? String(e.payload?.name ?? "") : "";
}
const isStepMark = (e: Entry) => ["loop.start", "loop.step.start", "loop.step", "loop.finish"].includes(eventName(e));
const isTurnMark = (e: Entry) => eventName(e) === "loop.start";

function initialMode(): Mode {
  return new URLSearchParams(location.search).get("mode") === "replay" ? "replay" : "live";
}

export default function App({ name: tapeName, onNavigate }: { name: string; onNavigate: (name: string | null) => void }) {
  const tape = useTape(tapeName);
  const { entries } = tape;

  const [mode, setModeState] = useState<Mode>(initialMode);
  const [opts, setOpts] = usePersistent<ViewOptions>("opts", DEFAULT_OPTS);
  const [theme, setTheme] = usePersistent<string>("theme", "");
  const [storedSpeed, setSpeed] = usePersistent<number>("speed", 4);
  const speed = SPEEDS.includes(storedSpeed) ? storedSpeed : 4; // a speed saved before the list changed
  const [skipIdle, setSkipIdle] = usePersistent<boolean>("skipIdle", true);
  const [autoscroll, setAutoscroll] = usePersistent<boolean>("autoscroll", true);
  const viewOpts = useMemo(() => ({ ...DEFAULT_OPTS, ...opts }), [opts]);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);

  // -- playback clock --------------------------------------------------------
  const pt = useMemo(
    () => playbackTimes(entries, skipIdle ? IDLE_CAP : Infinity),
    // entries is mutated in place; version tracks its content
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tape.version, tape.epoch, skipIdle],
  );
  const total = pt.length ? pt[pt.length - 1] : 0;
  const [vt, setVt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const vtRef = useRef(0);
  vtRef.current = vt;
  const totalRef = useRef(total);
  totalRef.current = total;

  const live = mode === "live";
  const shown = live ? entries.length : countAt(pt, vt);

  // -- timeline, folded incrementally ------------------------------------------
  const tlRef = useRef<{ tl: Timeline; epoch: number } | null>(null);
  let cache = tlRef.current;
  if (!cache || cache.epoch !== tape.epoch || cache.tl.count > shown) {
    cache = { tl: new Timeline(), epoch: tape.epoch };
    tlRef.current = cache;
  }
  const tl = cache.tl;
  tl.pushAll(entries, shown);

  // -- selection: which item the right pane shows ------------------------------------
  // "follow" tracks the latest turn (live: the one being written; replay: the one at the playhead).
  const [sel, setSel] = useState<Selection>({ kind: "follow" });
  const [showDetail, setShowDetail] = useState(false); // narrow screens show one pane at a time
  const latest = useMemo(() => {
    for (let k = tl.items.length - 1; k >= 0; k--) if (tl.items[k].type === "turn") return tl.items[k];
    return tl.items[tl.items.length - 1] ?? null;
  }, [tl.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = resolveSelection(tl.items, sel, latest);
  const following = sel.kind === "follow";

  // -- mode --------------------------------------------------------------------
  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    const url = new URL(location.href);
    if (next === "replay") url.searchParams.set("mode", "replay");
    else url.searchParams.delete("mode");
    history.replaceState(null, "", url);
    if (next === "replay") {
      // Stopping live pauses at the latest entry, so the view does not change; play from there restarts.
      setVt(totalRef.current);
      setPlaying(false);
    } else {
      setPlaying(false);
      setSel({ kind: "follow" });
      stick.current = true;
    }
  }, []);

  // Start a page opened with ?mode=replay playing once the tape is loaded (not when live is merely stopped).
  const autoStarted = useRef(mode !== "replay");
  useEffect(() => {
    if (!autoStarted.current && mode === "replay" && entries.length) {
      autoStarted.current = true;
      setPlaying(true);
    }
  }, [mode, entries.length]);

  // -- replay engine -------------------------------------------------------------
  useEffect(() => {
    if (!playing || mode !== "replay") return;
    // A timer rather than rAF: it keeps time in background tabs, and elapsed time is measured, not counted.
    // Advance from the current position on every tick, so seeking while playing sticks.
    let last = performance.now();
    if (vtRef.current >= totalRef.current) vtRef.current = 0;
    const id = setInterval(() => {
      const now = performance.now();
      const next = Math.min(totalRef.current, vtRef.current + (now - last) * speed);
      last = now;
      vtRef.current = next;
      setVt(next);
      if (next >= totalRef.current) setPlaying(false);
    }, 40);
    return () => clearInterval(id);
  }, [playing, mode, speed]);

  const seekIndex = useCallback((i: number) => setVt(pt[Math.max(0, Math.min(i, pt.length - 1))] ?? 0), [pt]);

  const jump = useCallback(
    (dir: 1 | -1, match: (e: Entry) => boolean) => {
      if (mode !== "replay") return;
      setSel({ kind: "follow" });
      if (dir > 0) {
        for (let i = shown; i < entries.length; i++) if (match(entries[i])) return seekIndex(i);
        return setVt(total);
      }
      const here = shown > 0 ? pt[shown - 1] : 0;
      for (let i = shown - 2; i >= 0; i--) if (match(entries[i]) && pt[i] < here) return seekIndex(i);
      setVt(0);
    },
    [mode, shown, entries, pt, total, seekIndex],
  );

  const togglePlay = useCallback(() => {
    if (mode !== "replay") return; // live: the playhead follows the tape
    if (!playing && vt >= total) setVt(0);
    if (!playing) setSel({ kind: "follow" });
    setPlaying(!playing);
  }, [mode, playing, vt, total, setMode]);

  const changeSkipIdle = (value: boolean) => {
    const next = playbackTimes(entries, value ? IDLE_CAP : Infinity);
    setSkipIdle(value);
    setVt(shown > 0 ? next[shown - 1] : 0);
  };

  // -- "now" on the tape's clock ----------------------------------------------
  const wall = useTicker(1000, mode === "live");
  const now = useMemo(() => {
    if (mode === "live") return wall;
    if (!shown) return 0;
    return parseDate(entries[shown - 1].date) + Math.max(0, vt - pt[shown - 1]);
  }, [mode, wall, shown, entries, vt, pt]);

  // -- scrolling ------------------------------------------------------------------
  const scroller = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  const follow = mode === "replay" || autoscroll;
  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (stick.current) setBehind(false);
  };
  // New entries: keep the followed turn scrolled to its newest step, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !following) return;
    if (follow && stick.current) el.scrollTop = el.scrollHeight;
    else if (tl.count) setBehind(true);
  }, [tl.version, follow]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another item selected: a followed turn opens at its newest step, a picked one at its top.
  // (A focus request scrolls on its own, see below.)
  const selectedId = selected?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || sel.kind === "entry") return;
    stick.current = following;
    setBehind(false);
    el.scrollTop = following ? el.scrollHeight : 0;
    listRef.current?.querySelector(`[data-item="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, following]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sel.kind === "entry") listRef.current?.querySelector(`[data-item="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, sel]);
  const toLatest = () => {
    stick.current = true;
    setBehind(false);
    if (!following) return setSel({ kind: "follow" });
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  const pick = useCallback(
    (item: Item) => {
      setSel(item.id === latest?.id ? { kind: "follow" } : { kind: "item", id: item.id });
      setShowDetail(true);
    },
    [latest],
  );

  // -- anchors ----------------------------------------------------------------------
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchors = useMemo(() => listAnchors(entries), [tape.version, tape.epoch]);
  const [focus, setFocus] = useState<Focus | null>(null);
  /** Reveal entry `i`: seek there in replay (paused), expand what contains it, scroll to it and flash it. */
  const goEntry = useCallback(
    (i: number, extra?: Pick<Focus, "kind" | "sub">) => {
      stick.current = false; // don't let follow-scrolling yank the view away
      setSel({ kind: "entry", i });
      setShowDetail(true);
      if (mode === "replay") {
        setPlaying(false);
        seekIndex(i);
      }
      setFocus((f) => ({ i, n: (f?.n ?? 0) + 1, ...extra }));
    },
    [mode, seekIndex],
  );
  const goAnchor = useCallback((i: number) => goEntry(i), [goEntry]);
  const stepAnchor = useCallback(
    (dir: 1 | -1) => {
      let target: AnchorRef | undefined;
      if (mode === "replay") {
        const here = shown ? pt[shown - 1] : -1;
        target = dir > 0 ? anchors.find((a) => a.i >= shown) : anchors.findLast((a) => pt[a.i] < here);
      } else {
        const cursor = focus?.i ?? (dir > 0 ? -1 : entries.length);
        target = dir > 0 ? anchors.find((a) => a.i > cursor) : anchors.findLast((a) => a.i < cursor);
      }
      if (target) goAnchor(target.i);
    },
    [mode, shown, pt, anchors, focus, entries.length, goAnchor],
  );
  useEffect(() => {
    if (!focus) return;
    const root = scroller.current;
    if (!root) return;
    // Expanding the containing turn (and then a tool call) takes a few renders, so poll frame by frame:
    // wait until the located element is the same two frames in a row, open what holds the match, wait for
    // that to render, then scroll (instantly: a smooth scroll is interrupted by layout shifts) and flash.
    let raf = 0;
    let prev: HTMLElement | null = null;
    let frames = 0;
    let revealed = 0;
    const tick = () => {
      frames++;
      if (!revealed) {
        const el = locate(root, focus);
        if (!el || (el !== prev && frames < 30)) {
          prev = el;
          raf = requestAnimationFrame(tick);
          return;
        }
        prev = el;
        reveal(el, focus, searchTerms(queryRef.current));
        revealed = frames;
      }
      if (frames - revealed < 2) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const el = prev!;
      const tall = el.offsetHeight > root.clientHeight * 0.6;
      el.scrollIntoView({ block: tall ? "start" : "center" });
      if (tall) scrollToMatch(el, root, searchTerms(queryRef.current));
      for (const old of root.querySelectorAll(".flash")) old.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  // -- search -----------------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  const [kinds, setKinds] = usePersistent<SearchKind[]>("searchKinds", []);
  const indexRef = useRef<{ index: SearchIndex; epoch: number } | null>(null);
  if (!indexRef.current || indexRef.current.epoch !== tape.epoch) indexRef.current = { index: new SearchIndex(), epoch: tape.epoch };
  const searchIndex = indexRef.current.index;
  if (searchOpen) searchIndex.update(entries);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchFocus((n) => n + 1);
  }, []);
  const pickHit = useCallback(
    (hit: SearchHit) => {
      // Make sure the matched block is not hidden by a view option.
      const need: Partial<ViewOptions> = {};
      if (hit.kind === "system" && !viewOpts.system) need.system = true;
      if (hit.kind === "event" && !viewOpts.events) need.events = true;
      if (hit.kind === "message" && hit.sub === 1 && !viewOpts.reasoning) need.reasoning = true;
      if (Object.keys(need).length) setOpts({ ...viewOpts, ...need });
      goEntry(hit.i, { kind: hit.kind, sub: hit.sub });
      // On narrow screens the panel covers the timeline; get out of the way (the query is kept).
      if (window.matchMedia("(max-width: 820px)").matches) setSearchOpen(false);
    },
    [viewOpts, setOpts, goEntry],
  );
  const terms = useMemo(() => (searchOpen ? searchTerms(query) : []), [searchOpen, query]);
  useSearchHighlight(scroller, terms, `${tl.version}-${focus?.n}-${JSON.stringify(viewOpts)}`);

  /** Select the next/previous turn in the list. */
  const stepItem = useCallback(
    (dir: 1 | -1) => {
      const turns = tl.items.filter((it) => it.type === "turn");
      const at = turns.findIndex((t) => t.id === selected?.id);
      const next = turns[at < 0 ? (dir > 0 ? 0 : turns.length - 1) : at + dir];
      if (next) pick(next);
    },
    [tl, selected, pick],
  );

  // -- keyboard ---------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if ((e.key === "f" && (e.metaKey || e.ctrlKey) && !e.altKey) || (e.key === "/" && !target.closest("input, select, textarea"))) {
        e.preventDefault();
        e.stopPropagation();
        return openSearch();
      }
      // Popups (Base UI Select/Popover) keep their own keyboard navigation.
      // The progress slider is an <input>, but the app shortcuts still apply to it.
      if (target.closest("input:not([type=range]), select, textarea, .pop") || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      if (key === " ") togglePlay();
      else if (key === "ArrowRight") jump(1, e.shiftKey ? isTurnMark : isStepMark);
      else if (key === "ArrowLeft") jump(-1, e.shiftKey ? isTurnMark : isStepMark);
      else if (key === "Home" && mode === "replay") setVt(0);
      else if (key === "End" && mode === "replay") setVt(total);
      else if (key === "j" || key === "J") stepItem(1);
      else if (key === "k" || key === "K") stepItem(-1);
      else if (key === "]") stepAnchor(1);
      else if (key === "[") stepAnchor(-1);
      else if (key === "l" || key === "L") setMode(mode === "live" ? "replay" : "live");
      else return;
      e.preventDefault();
      // Handled shortcuts win over focused widgets (e.g. arrow-key focus moves in the mode toggle group).
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [togglePlay, jump, stepAnchor, stepItem, mode, total, setMode, openSearch]);

  // -- derived view bits --------------------------------------------------------------
  const turns = tl.turns;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allTurns = useMemo(() => replayTurns(entries), [tape.version, tape.epoch]);
  const running = tl.openTurn?.status === "running" ? tl.openTurn : null;
  const name = tape.info?.name ?? tapeName;
  useEffect(() => {
    document.title = `Walkman · ${running ? "● " : ""}${name}`;
  }, [name, running]);

  const status = (() => {
    if (tape.connection === "loading") return { cls: "busy", text: "loading…" };
    if (tape.connection === "error") return { cls: "", text: `error: ${tape.error}` };
    if (tape.connection === "reconnecting") return { cls: "busy", text: "reconnecting…" };
    if (mode === "replay") return { cls: playing ? "busy" : "", text: playing ? `playing ${speed}×` : vt >= total ? "ended" : "paused" };
    if (running) return { cls: "busy live", text: `running · step ${running.steps.length || 1}` };
    return { cls: "live", text: tl.stats.last ? `live · idle ${duration(wall - tl.stats.last)}` : "live" };
  })();

  return (
    <NowContext.Provider value={now}>
      <div className={`app mode-${mode} ${playing ? "playing" : ""} ${running && mode === "live" ? "playing" : ""}`}>
        <main className="main">
          <header className="topbar">
            <button className="home" onClick={() => onNavigate(null)} title="All tapes" aria-label="All tapes">
              <Brand />
            </button>
            <div className="title">
              <TapeCrumbs name={tapeName} path={tape.info?.path} onPick={onNavigate} onHome={() => onNavigate(null)} />
              <div className="stats">
                <span>
                  <b>{tl.stats.turns}</b> turns
                </span>
                <span>
                  <b>{tl.stats.steps}</b> steps
                </span>
                <span>
                  <b>{tl.stats.tools}</b> tool calls
                </span>
                {tl.stats.errors > 0 && (
                  <span className="err-text">
                    <b>{tl.stats.errors}</b> errors
                  </span>
                )}
                <span>
                  <b>{tokens(tl.stats.output)}</b> out tokens
                </span>
                {tl.stats.first != null && tl.stats.last != null && <span>{duration(tl.stats.last - tl.stats.first)} span</span>}
                {tape.info?.size != null && <span>{bytes(tape.info.size)}</span>}
              </div>
            </div>
            <button
              className="icon-btn square search-btn"
              data-active={searchOpen || undefined}
              onClick={() => (searchOpen ? setSearchOpen(false) : openSearch())}
              title="Search (/ or ⌘F)"
              aria-label="Search"
            >
              <SearchIcon />
            </button>
            <div className={`status ${status.cls}`}>
              <span className="dot" />
              {status.text}
            </div>
            <SettingsPopover>
              {(
                [
                  ["system", "System prompts"],
                  ["reasoning", "Reasoning"],
                  ["events", "Low-level events"],
                  ["expandTools", "Expand tool calls"],
                ] as const
              ).map(([key, label]) => (
                <CheckField key={key} checked={viewOpts[key]} onChange={(v) => setOpts({ ...viewOpts, [key]: v })}>
                  {label}
                </CheckField>
              ))}
              <CheckField checked={autoscroll} onChange={setAutoscroll}>
                Auto-scroll when live
              </CheckField>
              <hr />
              <div className="menu-row">
                Theme
                <Segmented
                  label="Theme"
                  className="small"
                  value={theme || "auto"}
                  onPick={(v) => setTheme(v === "auto" ? "" : v)}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </div>
              <hr />
              <div className="hint">
                <kbd>/</kbd> search · <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> step · <kbd>⇧</kbd>+arrows turn · <kbd>J</kbd>/<kbd>K</kbd> turn list · <kbd>[</kbd>/<kbd>]</kbd> anchor · <kbd>L</kbd> live on/off
              </div>
            </SettingsPopover>
          </header>

          <div className={`content ${searchOpen ? "with-search" : ""}`}>
          <div className={`panes ${showDetail ? "show-detail" : ""}`}>
          <aside className={`list-pane ${anchors.length ? "has-head" : ""}`} ref={listRef}>
            {anchors.length > 0 && (
              <div className="list-head">
                <AnchorPicker anchors={anchors} passed={(a) => mode === "replay" && a.i < shown} onPick={goAnchor} />
              </div>
            )}
            <TurnList items={tl.items} opts={viewOpts} selected={selected?.id ?? null} onSelect={pick} version={tl.version} />
          </aside>
          <section className="detail-pane timeline-wrap" ref={scroller} onScroll={onScroll}>
            <button className="back" onClick={() => setShowDetail(false)}>
              <ChevronLeft size={14} />
              Turns
            </button>
            <div className="detail">
              <ItemDetail item={selected} v={selected?.v ?? 0} opts={viewOpts} />
            </div>
            {!tl.items.length && tape.connection !== "loading" && (
              <div className="empty">
                <p>
                  {mode === "replay" && entries.length
                    ? "Press Space or the play button to start the replay."
                    : tape.connection === "error"
                      ? `Could not load the tape: ${tape.error}. Pick another one from the tape name above.`
                      : "This tape is empty. Waiting for entries…"}
                </p>
              </div>
            )}
          </section>
          </div>

          {(behind || !following) && latest && (
            <button className="jump" onClick={toLatest}>
              <ArrowDown size={14} />
              Latest
            </button>
          )}
          {searchOpen && (
            <SearchPanel
              index={searchIndex}
              version={tape.version + tape.epoch * 1e9}
              query={query}
              onQuery={setQuery}
              kinds={kinds}
              onKinds={setKinds}
              focusSignal={searchFocus}
              ahead={(i) => mode === "replay" && i >= shown}
              onPick={pickHit}
              onClose={() => setSearchOpen(false)}
            />
          )}
          </div>

          <footer className="transport">
            <div className="controls">
              <button className="icon-btn" onClick={() => setVt(0)} disabled={live} title="Restart (Home)" aria-label="Restart">
                <SkipStart />
              </button>
              <button className="icon-btn" onClick={() => jump(-1, isStepMark)} disabled={live} title="Previous step (←, ⇧← previous turn)" aria-label="Previous step">
                <ChevronLeft />
              </button>
              <button
                className="icon-btn play"
                onClick={togglePlay}
                disabled={live}
                title={live ? "Stop live to play the tape back" : "Play / pause (Space)"}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? <Pause /> : <Play />}
              </button>
              <button className="icon-btn" onClick={() => jump(1, isStepMark)} disabled={live} title="Next step (→, ⇧→ next turn)" aria-label="Next step">
                <ChevronRight />
              </button>
              <button className="icon-btn" onClick={() => setVt(total)} disabled={live} title="Jump to end (End)" aria-label="Jump to end">
                <SkipEnd />
              </button>
              <SpeedSelect speeds={SPEEDS} value={speed} onChange={setSpeed} />
              <CheckField small checked={skipIdle} onChange={changeSkipIdle} title="Compress idle gaps longer than 2s">
                skip idle
              </CheckField>
            </div>
            <Track
              disabled={live}
              turns={mode === "replay" ? allTurns : turns}
              anchors={anchors}
              pt={pt}
              total={total}
              vt={mode === "replay" ? vt : total}
              onSeek={(v) => {
                setSel({ kind: "follow" });
                setVt(v);
              }}
            />
            <div className="clock">
              {mode === "replay"
                ? `${clock(vt)} / ${clock(total)}`
                : tl.stats.last
                  ? `last ${timeOfDay(tl.stats.last)}`
                  : "--:--"}
            </div>
            <Toggle
              className="live-btn"
              pressed={live}
              onPressedChange={(on) => setMode(on ? "live" : "replay")}
              // Space is the app-wide play/pause key; don't let the toggle turn it into a click.
              onKeyDown={(e) => e.key === " " && e.preventBaseUIHandler()}
              title={live ? "Stop following the tape (L)" : "Follow the tape as it is written (L)"}
            >
              <span className="live-dot" />
              {live ? "Stop Live" : "Live"}
            </Toggle>
          </footer>
        </main>
      </div>
    </NowContext.Provider>
  );
}

type Selection = { kind: "follow" } | { kind: "item"; id: string } | { kind: "entry"; i: number };

/** The item a selection points at; falls back to the latest turn when it is gone (e.g. after seeking back). */
function resolveSelection(items: Item[], sel: Selection, latest: Item | null): Item | null {
  if (sel.kind === "item") return items.find((it) => it.id === sel.id) ?? latest;
  if (sel.kind === "entry") {
    let before: Item | null = null;
    for (const it of items) {
      if (it.i0 <= sel.i && sel.i <= it.i1) return it;
      if (it.i0 <= sel.i) before = it;
    }
    return before ?? latest;
  }
  return latest;
}

interface TrackTurn {
  id: string;
  i0: number;
  i1: number;
  status: string;
}

/** In replay the track shows every turn of the tape, not just the revealed ones. */
function replayTurns(entries: Entry[]): TrackTurn[] {
  const result: TrackTurn[] = [];
  let open: TrackTurn | null = null;
  entries.forEach((e, i) => {
    const name = eventName(e);
    if (name === "loop.start") {
      open = { id: `t${i}`, i0: i, i1: i, status: "running" };
      result.push(open);
    } else if (open) {
      open.i1 = i;
      if (name === "loop.finish") {
        open.status = String(e.payload?.data?.status ?? "ok");
        open = null;
      }
    }
  });
  return result;
}

function Track({
  disabled,
  turns,
  anchors,
  pt,
  total,
  vt,
  onSeek,
}: {
  disabled: boolean;
  turns: Array<Pick<Turn, "id" | "i0" | "i1" | "status">>;
  anchors: AnchorRef[];
  pt: number[];
  total: number;
  vt: number;
  onSeek: (vt: number) => void;
}) {
  const pct = (v: number) => (total ? (v / total) * 100 : 0);
  return (
    <div className={`track ${disabled ? "disabled" : ""}`} title={disabled ? "Stop live to seek" : "Drag to seek"}>
      <div className="track-turns">
        {turns.map((t) => (
          <i
            key={t.id}
            className={t.status}
            style={{ left: `${pct(pt[t.i0] ?? 0)}%`, width: `${Math.max(pct((pt[t.i1] ?? 0) - (pt[t.i0] ?? 0)), 0.4)}%` }}
          />
        ))}
      </div>
      {anchors.map((a) => (
        <b key={a.i} className="track-anchor" style={{ left: `${pct(pt[a.i] ?? 0)}%` }} />
      ))}
      <div className="track-fill" style={{ width: `${pct(vt)}%` }} />
      <div className="track-head" style={{ left: `${pct(vt)}%` }} />
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={total ? Math.round((vt / total) * 1000) : 0}
        onChange={(e) => onSeek((Number(e.target.value) / 1000) * total)}
        disabled={disabled}
        aria-label="Playback position"
      />
    </div>
  );
}

/** The element that best represents a focus target: the exact tool call/result, else the deepest element at or before it. */
function locate(root: HTMLElement, focus: Focus): HTMLElement | null {
  const { i, kind, sub } = focus;
  if (kind === "tool_result") {
    const el = root.querySelector<HTMLElement>(`[data-result="${i}"][data-rsub="${sub ?? 0}"]`) ?? root.querySelector<HTMLElement>(`[data-result="${i}"]`);
    if (el) return el;
  }
  if (kind === "tool_call") {
    const el = root.querySelector<HTMLElement>(`[data-entry="${i}"][data-sub="${sub ?? 0}"]`);
    if (el) return el;
  }
  // Entries that render nothing of their own (loop events, the turn's prompt message, hidden blocks) fall back to
  // the closest element before them. Ties go to the last one in document order, i.e. the most deeply nested.
  let best: HTMLElement | null = null;
  let bestAt = -1;
  for (const el of root.querySelectorAll<HTMLElement>("[data-entry]")) {
    const at = Number(el.dataset.entry);
    if (at <= i && at >= bestAt) [best, bestAt] = [el, at];
  }
  return best;
}

/** Open the collapsed parts of `el` that hold the match: the element itself when it is a tool, and reasoning/system disclosures. */
function reveal(el: HTMLElement, focus: Focus, terms: string[]) {
  if (focus.kind === "tool_call" || focus.kind === "tool_result") {
    if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
    return;
  }
  if (el instanceof HTMLDetailsElement && el.classList.contains("sys")) el.open = true;
  if (!terms.length) return;
  for (const d of el.querySelectorAll<HTMLDetailsElement>("details.reasoning, details.sys")) {
    const text = (d.textContent ?? "").toLowerCase();
    if (!d.open && terms.every((t) => text.includes(t))) d.open = true;
  }
}

/** Paint every occurrence of the search terms in the timeline with the CSS Custom Highlight API (no DOM changes). */
function useSearchHighlight(scroller: React.RefObject<HTMLElement | null>, terms: string[], dep: string) {
  useEffect(() => {
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!registry || typeof Highlight === "undefined") return;
    if (!terms.length || !scroller.current) {
      registry.delete("search");
      return;
    }
    const root = scroller.current;
    let raf = 0;
    const paint = () => {
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node && ranges.length < 5000; node = walker.nextNode() as Text | null) {
        const text = node.data.toLowerCase();
        for (const term of terms) {
          for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + term.length)) {
            const r = new Range();
            r.setStart(node, at);
            r.setEnd(node, at + term.length);
            ranges.push(r);
          }
        }
      }
      registry.set("search", new Highlight(...ranges));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(paint);
    };
    schedule();
    // Expanding a tool call or a turn renders new text; <details> toggles don't bubble, so listen in capture.
    root.addEventListener("toggle", schedule, true);
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener("toggle", schedule, true);
    };
  }, [scroller, terms, dep]);
  useEffect(() => () => void (typeof CSS !== "undefined" && CSS.highlights?.delete("search")), []);
}

/** Bring the first occurrence of the terms inside `el` into view, including inside scrollable boxes like long outputs. */
function scrollToMatch(el: HTMLElement, root: HTMLElement, terms: string[]) {
  if (!terms.length) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.toLowerCase().indexOf(terms[0]);
    if (at < 0 || !node.parentElement?.checkVisibility()) continue;
    const range = new Range();
    range.setStart(node, at);
    range.setEnd(node, at + terms[0].length);
    for (let box = node.parentElement as HTMLElement | null; box && box !== root; box = box.parentElement) {
      if (box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY !== "visible") {
        const r = range.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - box.clientHeight / 3;
      }
    }
    const r = range.getBoundingClientRect();
    const v = root.getBoundingClientRect();
    if (r.top < v.top || r.bottom > v.bottom) root.scrollTop += r.top - v.top - root.clientHeight / 3;
    return;
  }
}
