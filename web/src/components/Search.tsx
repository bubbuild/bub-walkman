import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Toggle } from "@base-ui/react/toggle";
import { timeOfDay } from "../format";
import { SEARCH_KINDS, search, type SearchHit, type SearchIndex, type SearchKind } from "../model";
import { ChevronDown, Close, Search as SearchIcon } from "./icons";

export const KIND_LABELS: Record<SearchKind, string> = {
  message: "Messages",
  tool_call: "Tool calls",
  tool_result: "Results",
  system: "System",
  anchor: "Anchors",
  event: "Events",
};

const TAGS: Record<SearchKind, string> = {
  message: "msg",
  tool_call: "call",
  tool_result: "result",
  system: "system",
  anchor: "anchor",
  event: "event",
};

/**
 * Full-text search over every entry of the tape (also those a replay has not reached yet).
 * The kind filter is a multi-select; none selected means all kinds.
 */
export function SearchPanel({
  index,
  version,
  query,
  onQuery,
  kinds,
  onKinds,
  focusSignal,
  ahead,
  onPick,
  onClose,
}: {
  index: SearchIndex;
  version: number;
  query: string;
  onQuery: (q: string) => void;
  kinds: SearchKind[];
  onKinds: (k: SearchKind[]) => void;
  /** Changes whenever the input should take focus. */
  focusSignal: number;
  /** Whether an entry is past the replay playhead. */
  ahead: (i: number) => boolean;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const deferred = useDeferredValue(query);
  const kindSet = useMemo(() => new Set(kinds), [kinds]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => search(index, deferred, kindSet), [index, deferred, kindSet, version]);
  const [sel, setSel] = useState(-1);

  useEffect(() => setSel(-1), [deferred, kinds]);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);
  useEffect(() => {
    list.current?.querySelector(`[data-hit="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const go = (k: number) => {
    const n = result.hits.length;
    if (!n) return;
    const next = ((k % n) + n) % n;
    setSel(next);
    onPick(result.hits[next]);
  };

  const toggleKind = (k: SearchKind) => onKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : SEARCH_KINDS.filter((x) => x === k || kinds.includes(x)));
  const all = Object.values(result.counts).reduce((a, b) => a + b, 0);

  return (
    <aside
      className="search"
      aria-label="Search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="search-head">
        <div className="search-box">
          <SearchIcon size={14} className="lead" />
          <input
            ref={input}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder='Search the tape  ·  "exact phrase"'
            spellCheck={false}
            aria-label="Search text"
            onKeyDown={(e) => {
              if (e.key === "Enter") go(sel + (e.shiftKey ? -1 : 1));
              else if (e.key === "ArrowDown") go(sel + 1);
              else if (e.key === "ArrowUp") go(sel - 1);
              else return;
              e.preventDefault();
            }}
          />
          {query && (
            <button className="icon-btn tiny" onClick={() => onQuery("")} title="Clear" aria-label="Clear search">
              <Close size={12} />
            </button>
          )}
        </div>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close search">
          <Close size={14} />
        </button>
      </div>
      <div className="chips" role="group" aria-label="Entry kinds">
        <Toggle className="chip" pressed={!kinds.length} onPressedChange={() => onKinds([])}>
          All{query.trim() ? <span className="n">{all}</span> : null}
        </Toggle>
        {SEARCH_KINDS.map((k) => (
          <Toggle key={k} className="chip" data-kind={k} pressed={kinds.includes(k)} onPressedChange={() => toggleKind(k)}>
            {KIND_LABELS[k]}
            {query.trim() ? <span className="n">{result.counts[k]}</span> : null}
          </Toggle>
        ))}
      </div>
      <div className="search-sum">
        {!deferred.trim() ? (
          <span>Type to search messages, tool calls, results and events.</span>
        ) : result.total ? (
          <>
            <span>
              {sel >= 0 ? `${sel + 1} / ` : ""}
              {result.total} match{result.total === 1 ? "" : "es"}
              {result.total > result.hits.length ? `, showing first ${result.hits.length}` : ""}
            </span>
            <span className="nav">
              <button className="icon-btn tiny" onClick={() => go(sel - 1)} title="Previous (⇧Enter)" aria-label="Previous match">
                <ChevronDown size={14} style={{ transform: "rotate(180deg)" }} />
              </button>
              <button className="icon-btn tiny" onClick={() => go(sel + 1)} title="Next (Enter)" aria-label="Next match">
                <ChevronDown size={14} />
              </button>
            </span>
          </>
        ) : (
          <span>No matches{kinds.length ? " in the selected kinds" : ""}.</span>
        )}
      </div>
      <div className="hits" ref={list}>
        {result.hits.map((hit, k) => (
          <button
            key={hit.i}
            className={`hit ${k === sel ? "sel" : ""} ${ahead(hit.i) ? "ahead" : ""}`}
            data-hit={k}
            onClick={() => {
              setSel(k);
              onPick(hit);
            }}
          >
            <span className="hit-head">
              <span className={`tag ${hit.kind}`}>{TAGS[hit.kind]}</span>
              {hit.label && <span className="hit-label">{hit.label}</span>}
              <span className="hit-time">{timeOfDay(hit.t)}</span>
            </span>
            <span className="hit-text">
              {hit.snippet.map((run, j) => (run.match ? <mark key={j}>{run.text}</mark> : <span key={j}>{run.text}</span>))}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
