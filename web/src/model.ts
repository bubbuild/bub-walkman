// Folds raw tape entries into a timeline of turns → steps → blocks.
//
// Bub writes a turn as:
//   event loop.start → (event loop.step.start → system/message/tool_call/tool_result/event run → event loop.step)* → event loop.finish
// Everything inside a step is flushed when the step ends, so timing is only known per step.
// The model is mutable for cheap incremental appends; every touched item bumps `v` so views can memoize.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Entry {
  id: number;
  kind: string;
  payload: any;
  meta?: Record<string, any>;
  date: string;
}

export type Status = "running" | "ok" | "error" | "cancelled" | "continue" | "unfinished" | "unknown" | (string & {});

export interface Usage {
  input: number;
  output: number;
  cached: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: string;
  done: boolean;
  result?: unknown;
  /** Entry index of the tool_result entry, and this call's position in it. */
  ri?: number;
  rj?: number;
}

export interface PlanEntry {
  content: string;
  status: string;
  priority?: string;
}

export type Block = (
  | { type: "system"; key: string; content: string }
  | { type: "message"; key: string; role: string; content: string; reasoning?: string }
  | { type: "tools"; key: string; content?: string; reasoning?: string; calls: ToolCall[] }
  | { type: "results"; key: string; results: unknown[] }
  | { type: "plan"; key: string; entries: PlanEntry[] }
  | { type: "anchor"; key: string; name: string; state?: unknown; i: number }
  | { type: "command"; key: string; data: any }
  | { type: "event"; key: string; name: string; data: any }
) & {
  /** Entry index this block came from (set when the block is added). */
  i?: number;
};

export interface Step {
  key: string;
  /** Entry index the step started at. */
  i0: number;
  n: number;
  t0: number;
  t1: number | null;
  status: Status;
  error?: string;
  blocks: Block[];
  usage?: Usage;
  model?: string;
  toolCount: number;
}

interface ItemBase {
  id: string;
  /** Bumped on every mutation. */
  v: number;
  /** Index of the first / last entry belonging to this item. */
  i0: number;
  i1: number;
  t0: number;
}

export interface Turn extends ItemBase {
  type: "turn";
  t1: number | null;
  implicit: boolean;
  model?: string;
  prompt?: string;
  status: Status;
  error?: string;
  steps: Step[];
  usage: Usage;
  toolCount: number;
}

export interface AnchorItem extends ItemBase {
  type: "anchor";
  name: string;
  state?: unknown;
}

export interface MiscItem extends ItemBase {
  type: "misc";
  kind: string;
  name: string;
  data: any;
}

export type Item = Turn | AnchorItem | MiscItem;

export interface Stats {
  turns: number;
  steps: number;
  tools: number;
  errors: number;
  output: number;
  first: number | null;
  last: number | null;
}

const QUIET_EVENTS = new Set(["handoff"]);

export function parseDate(date: string | undefined): number {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function normalizeUsage(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    input: num(u.prompt_tokens ?? u.input_tokens),
    output: num(u.completion_tokens ?? u.output_tokens),
    cached: num(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens),
  };
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function str(x: unknown): string {
  if (typeof x === "string") return x;
  if (x == null) return "";
  return JSON.stringify(x);
}

export function normalizeCall(raw: any, index: number): ToolCall {
  const fn = raw?.function ?? {};
  const args = raw?.arguments ?? fn.arguments ?? raw?.input ?? "";
  return {
    id: String(raw?.id ?? `call-${index}`),
    name: String(raw?.name ?? fn.name ?? "tool"),
    args: typeof args === "string" ? args : JSON.stringify(args),
    done: false,
  };
}

export class Timeline {
  items: Item[] = [];
  stats: Stats = { turns: 0, steps: 0, tools: 0, errors: 0, output: 0, first: null, last: null };
  /** Number of entries folded in so far. */
  count = 0;
  /** Bumped on every push; cheap change detection for views. */
  version = 0;

  private turn: Turn | null = null;
  private step: Step | null = null;
  private seq = 0;

  get openTurn(): Turn | null {
    return this.turn;
  }

  get openStep(): Step | null {
    return this.step;
  }

  get turns(): Turn[] {
    return this.items.filter((i): i is Turn => i.type === "turn");
  }

  pushAll(entries: Entry[], upTo = entries.length): void {
    for (let i = this.count; i < upTo; i++) this.push(entries[i]);
  }

  push(entry: Entry): void {
    const index = this.count++;
    this.version++;
    const t = parseDate(entry.date);
    if (t) {
      this.stats.first ??= t;
      this.stats.last = Math.max(this.stats.last ?? t, t);
    }
    const payload = entry.payload ?? {};
    switch (entry.kind) {
      case "anchor":
        return this.onAnchor(index, t, payload);
      case "event":
        return this.onEvent(index, t, String(payload.name ?? ""), payload.data ?? {});
      case "system":
        return this.addBlock(index, t, { type: "system", key: "", content: str(payload.content) });
      case "message":
        return this.addBlock(index, t, {
          type: "message",
          key: "",
          role: String(payload.role ?? "assistant"),
          content: str(payload.content),
          reasoning: payload.reasoning ? str(payload.reasoning) : undefined,
        });
      case "tool_call": {
        const calls = (Array.isArray(payload.calls) ? payload.calls : []).map(normalizeCall);
        this.stats.tools += calls.length;
        return this.addBlock(index, t, {
          type: "tools",
          key: "",
          content: payload.content ? str(payload.content) : undefined,
          reasoning: payload.reasoning ? str(payload.reasoning) : undefined,
          calls,
        });
      }
      case "tool_result":
        return this.onResults(index, t, Array.isArray(payload.results) ? payload.results : [payload.results]);
      default:
        return this.addBlock(index, t, { type: "event", key: "", name: entry.kind, data: payload });
    }
  }

  // -- structure -------------------------------------------------------

  private newItem<T extends Item>(item: Omit<T, "id" | "v">): T {
    const full = { ...item, id: `i${this.seq++}`, v: 0 } as T;
    this.items.push(full);
    return full;
  }

  private touch(index: number): void {
    if (this.turn) {
      this.turn.v++;
      this.turn.i1 = index;
    }
  }

  private startTurn(index: number, t: number, data: any, implicit: boolean): Turn {
    this.closeTurn("unfinished");
    this.stats.turns++;
    this.turn = this.newItem<Turn>({
      type: "turn",
      i0: index,
      i1: index,
      t0: t,
      t1: null,
      implicit,
      model: data.model,
      prompt: data.prompt != null ? str(data.prompt) : undefined,
      status: implicit ? "unknown" : "running",
      steps: [],
      usage: { input: 0, output: 0, cached: 0 },
      toolCount: 0,
    });
    return this.turn;
  }

  private closeTurn(status: Status): void {
    const turn = this.turn;
    if (!turn) return;
    this.closeStep(status === "unfinished" ? "unfinished" : status, null);
    if (turn.status === "running") turn.status = status;
    turn.t1 ??= Math.max(this.lastBlockTime ?? turn.t0, turn.t0);
    turn.v++;
    this.turn = null;
  }

  private ensureTurn(index: number, t: number): Turn {
    return this.turn ?? this.startTurn(index, t, {}, true);
  }

  private startStep(index: number, t: number, n?: number): Step {
    const turn = this.ensureTurn(index, t);
    this.closeStep("unfinished", null);
    this.stats.steps++;
    const step: Step = {
      key: `${turn.id}-s${turn.steps.length}`,
      i0: index,
      n: n ?? turn.steps.length + 1,
      t0: t,
      t1: null,
      status: turn.implicit ? "unknown" : "running",
      blocks: [],
      toolCount: 0,
    };
    turn.steps.push(step);
    this.step = step;
    return step;
  }

  private closeStep(status: Status, t: number | null, error?: string): void {
    const step = this.step;
    if (!step) return;
    const placeholder = status === "unfinished" && step.status === "unknown";
    if (!placeholder && (step.status === "running" || step.status === "unknown" || status === "error")) step.status = status;
    if (error) step.error = error;
    if (t != null) step.t1 = t;
    else step.t1 ??= this.lastBlockTime ?? step.t0;
    this.step = null;
  }

  private lastBlockTime: number | null = null;

  private addBlock(index: number, t: number, block: Block): void {
    const step = this.step ?? this.startStep(index, t);
    const turn = this.turn!;
    block.key = `${step.key}-b${step.blocks.length}`;
    block.i = index;
    if (block.type === "tools") {
      step.toolCount += block.calls.length;
      turn.toolCount += block.calls.length;
    }
    if (block.type === "message" && block.role === "user" && turn.prompt == null) turn.prompt = block.content;
    step.blocks.push(block);
    this.lastBlockTime = t;
    if (turn.implicit) turn.t1 = t;
    this.touch(index);
  }

  // -- handlers --------------------------------------------------------

  private onAnchor(index: number, t: number, payload: any): void {
    const name = String(payload.name ?? "anchor");
    if (this.turn) {
      this.addBlock(index, t, { type: "anchor", key: "", name, state: payload.state, i: index });
      return;
    }
    this.newItem<AnchorItem>({ type: "anchor", i0: index, i1: index, t0: t, name, state: payload.state });
  }

  private onResults(index: number, t: number, results: unknown[]): void {
    const turn = this.turn;
    // Pair results with the most recent tool calls still waiting for one, in order.
    const pending: ToolCall[] = [];
    if (turn) {
      outer: for (let s = turn.steps.length - 1; s >= 0; s--) {
        const blocks = turn.steps[s].blocks;
        for (let b = blocks.length - 1; b >= 0; b--) {
          const block = blocks[b];
          if (block.type !== "tools") continue;
          const waiting = block.calls.filter((c) => !c.done);
          if (waiting.length) {
            pending.push(...waiting);
            break outer;
          }
        }
      }
    }
    if (!pending.length) {
      this.addBlock(index, t, { type: "results", key: "", results });
      return;
    }
    results.forEach((result, i) => {
      const call = pending[i];
      if (call) {
        call.result = result;
        call.done = true;
        call.ri = index;
        call.rj = i;
      }
    });
    this.lastBlockTime = t;
    this.touch(index);
  }

  private onEvent(index: number, t: number, name: string, data: any): void {
    switch (name) {
      case "loop.start":
        this.startTurn(index, t, data, false);
        return;
      case "loop.step.start":
        this.startStep(index, t, typeof data.step === "number" ? data.step : undefined);
        if (this.turn && !this.turn.implicit) {
          this.turn.status = "running";
          this.turn.t1 = null;
        }
        this.touch(index);
        return;
      case "loop.step": {
        if (!this.step) this.startStep(index, t, data.step);
        const end = parseDate(data.date) || t;
        const status = String(data.status ?? "ok");
        if (status === "error") this.stats.errors++;
        this.closeStep(status, end, data.error ? str(data.error) : undefined);
        // A terminal step ends the loop. Older Bub versions never write loop.finish, so settle the turn
        // provisionally here; loop.finish (if any) overrides, and another loop.step.start reopens it.
        const turn = this.turn;
        if (turn && !turn.implicit && status !== "continue") {
          turn.status = status;
          turn.t1 = end;
        }
        this.touch(index);
        return;
      }
      case "loop.finish": {
        const turn = this.ensureTurn(index, t);
        const end = parseDate(data.date) || t;
        turn.status = String(data.status ?? "ok");
        if (data.error) turn.error = str(data.error);
        turn.t1 = end;
        this.touch(index);
        this.closeStep(turn.status === "ok" ? "ok" : turn.status, end);
        this.turn = null;
        return;
      }
      case "run": {
        const step = this.step ?? this.startStep(index, t);
        const usage = normalizeUsage(data.usage);
        if (data.model) step.model = String(data.model);
        if (usage) {
          step.usage = usage;
          const total = this.turn!.usage;
          total.output += usage.output;
          total.input = Math.max(total.input, usage.input);
          total.cached = usage.cached;
          this.stats.output += usage.output;
        }
        if (data.model && !this.turn!.model) this.turn!.model = String(data.model);
        if (data.status && data.status !== "ok" && data.error) step.error = str(data.error);
        this.touch(index);
        return;
      }
      case "plan":
        this.addOrTopLevel(index, t, { type: "plan", key: "", entries: Array.isArray(data.entries) ? data.entries : [] });
        return;
      case "command":
        this.addOrTopLevel(index, t, { type: "command", key: "", data });
        return;
      default:
        if (QUIET_EVENTS.has(name)) return;
        this.addOrTopLevel(index, t, { type: "event", key: "", name, data });
    }
  }

  private addOrTopLevel(index: number, t: number, block: Block): void {
    if (this.turn) {
      this.addBlock(index, t, block);
      return;
    }
    const name = block.type === "event" ? block.name : block.type;
    const data = block.type === "event" || block.type === "command" ? block.data : block;
    this.newItem<MiscItem>({ type: "misc", i0: index, i1: index, t0: t, kind: block.type, name, data });
  }
}

/** Playback clock for each entry: real gaps, optionally capped so idle time is compressed. */
export function playbackTimes(entries: Entry[], idleCap: number): number[] {
  const pt = new Array<number>(entries.length);
  let prev = 0;
  let acc = 0;
  for (let i = 0; i < entries.length; i++) {
    const t = parseDate(entries[i].date);
    if (i > 0 && t && prev) acc += Math.min(Math.max(t - prev, 0), idleCap);
    if (t) prev = t;
    pt[i] = acc;
  }
  return pt;
}

export interface AnchorRef {
  /** Entry index. */
  i: number;
  name: string;
  t: number;
}

export function listAnchors(entries: Entry[]): AnchorRef[] {
  const anchors: AnchorRef[] = [];
  entries.forEach((e, i) => {
    if (e.kind === "anchor") anchors.push({ i, name: String(e.payload?.name ?? "anchor"), t: parseDate(e.date) });
  });
  return anchors;
}

/** Number of entries visible at playback time `vt` (all with pt <= vt). */
export function countAt(pt: number[], vt: number): number {
  let lo = 0;
  let hi = pt.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pt[mid] <= vt) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// -- presentation helpers ------------------------------------------------

export interface ParsedPrompt {
  meta: string[];
  date?: string;
  body: string;
  /** The part worth showing as a headline: the <user_request> when the prompt is wrapped, else the body. */
  headline: string;
}

/** Split Bub's channel header (`k=v|k=v` line and `---Date: ...---`) from the prompt text. */
export function parsePrompt(text: string | undefined): ParsedPrompt {
  let body = text ?? "";
  let meta: string[] = [];
  let date: string | undefined;
  const first = body.match(/^([^\n]*)\n/);
  if (first && /^[\w$.-]+=[^|\n]*(\|[\w$.-]+=[^|\n]*)*$/.test(first[1])) {
    meta = first[1].split("|");
    body = body.slice(first[0].length);
  }
  const d = body.match(/^---Date: (.+?)---\n?/);
  if (d) {
    date = d[1];
    body = body.slice(d[0].length);
  }
  body = body.trim();
  const request = body.match(/<user_request>\s*([\s\S]*?)\s*<\/user_request>/)?.[1];
  // Without a <user_request> wrapper, drop the injected <snake_case>…</snake_case> blocks around the user text.
  const stripped = request == null ? body.replace(/<([a-z][a-z0-9_]*)>[\s\S]*?<\/\1>/g, "").trim() : "";
  return { meta, date, body, headline: request ?? (stripped || body) };
}

const ARG_KEYS = ["cmd", "command", "path", "file_path", "url", "query", "q", "pattern", "name", "handle", "message", "text", "content"];

export function parseArgs(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

export function summarizeArgs(args: string): string {
  const parsed = parseArgs(args);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const key of ARG_KEYS) {
      if (typeof obj[key] === "string" && obj[key]) return oneLine(obj[key] as string);
    }
    const firstStr = Object.values(obj).find((v) => typeof v === "string" && v);
    if (typeof firstStr === "string") return oneLine(firstStr);
    const json = JSON.stringify(obj);
    return json === "{}" ? "" : oneLine(json);
  }
  return oneLine(String(parsed));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 240);
}

export interface ResultView {
  text: string;
  failed: boolean;
  spill?: string;
}

export function viewResult(result: unknown): ResultView {
  if (result == null) return { text: "", failed: false };
  if (typeof result === "string") {
    const spill = result.match(/handle: ([0-9a-f]{12,})/)?.[1];
    return { text: result, failed: /^Tool '.*' execution failed/.test(result), spill };
  }
  const obj = result as Record<string, any>;
  const failed = typeof obj === "object" && ("message" in obj || "error" in obj) && (obj.kind != null || "details" in obj || "error" in obj);
  const text = failed && obj.message
    ? [obj.message, obj.details?.error ?? (obj.details ? JSON.stringify(obj.details, null, 2) : "")].filter(Boolean).join("\n")
    : JSON.stringify(result, null, 2);
  return { text, failed };
}

// -- search ----------------------------------------------------------------

export const SEARCH_KINDS = ["message", "tool_call", "tool_result", "system", "anchor", "event"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export function searchKind(kind: string): SearchKind {
  return (SEARCH_KINDS as readonly string[]).includes(kind) ? (kind as SearchKind) : "event";
}

function argsText(args: string): string {
  const parsed = parseArgs(args);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return Object.entries(parsed as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
  }
  return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
}

/** Searchable parts of an entry, roughly as the timeline shows them. `sub` of a hit is the part index. */
export function entryParts(e: Entry): string[] {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "message":
      return [str(p.content), p.reasoning ? str(p.reasoning) : ""];
    case "tool_call": {
      const calls = (Array.isArray(p.calls) ? p.calls : []).map(normalizeCall);
      return [...calls.map((c: ToolCall) => `${c.name}\n${argsText(c.args)}`), p.content ? str(p.content) : "", p.reasoning ? str(p.reasoning) : ""];
    }
    case "tool_result":
      return (Array.isArray(p.results) ? p.results : [p.results]).map((r: unknown) => (typeof r === "string" ? r : JSON.stringify(r)));
    case "system":
      return [str(p.content)];
    case "anchor":
      return [`${str(p.name)}\n${p.state == null ? "" : JSON.stringify(p.state)}`];
    case "event":
      return [`${str(p.name)}\n${p.data == null ? "" : JSON.stringify(p.data)}`];
    default:
      return [`${e.kind}\n${JSON.stringify(p)}`];
  }
}

interface Indexed {
  kind: SearchKind;
  label: string;
  t: number;
  parts: string[];
  lower: string[];
}

/** Incremental full-text index over tape entries (append-only between resets). */
export class SearchIndex {
  docs: Indexed[] = [];
  private pending: string[] = [];

  update(entries: Entry[]): void {
    for (let i = this.docs.length; i < entries.length; i++) {
      const e = entries[i];
      const parts = entryParts(e);
      const p = e.payload ?? {};
      let label = "";
      if (e.kind === "message") label = String(p.role ?? "assistant");
      else if (e.kind === "tool_call") {
        const names = (Array.isArray(p.calls) ? p.calls : []).map((c: any, j: number) => normalizeCall(c, j).name);
        this.pending = names;
        label = names.join(", ");
      } else if (e.kind === "tool_result") {
        label = this.pending.join(", ");
        this.pending = [];
      } else if (e.kind === "anchor" || e.kind === "event") label = str(p.name);
      this.docs.push({ kind: searchKind(e.kind), label, t: parseDate(e.date), parts, lower: parts.map((x) => x.toLowerCase()) });
    }
  }
}

export interface SearchHit {
  /** Entry index. */
  i: number;
  /** Part of the entry that matched (tool call / tool result position, or message content vs reasoning). */
  sub: number;
  kind: SearchKind;
  label: string;
  t: number;
  /** Text around the first match, split into plain / matched runs. */
  snippet: Array<{ text: string; match: boolean }>;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Matches per kind, ignoring the kind filter. */
  counts: Record<SearchKind, number>;
  /** Total matches for the active kinds (hits may be capped). */
  total: number;
}

/** Lower-cased terms; whitespace separates terms, "double quotes" keep a phrase together. */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.toLowerCase().matchAll(/"([^"]*)"?|(\S+)/g)) {
    const term = m[1] ?? m[2];
    if (term && term.trim()) terms.push(term);
  }
  return terms;
}

/** Entries whose text contains every term (case-insensitive), in tape order. */
export function search(index: SearchIndex, query: string, kinds: ReadonlySet<SearchKind>, limit = 500): SearchResult {
  const counts = Object.fromEntries(SEARCH_KINDS.map((k) => [k, 0])) as Record<SearchKind, number>;
  const terms = searchTerms(query);
  const hits: SearchHit[] = [];
  let total = 0;
  if (!terms.length) return { hits, counts, total };
  index.docs.forEach((doc, i) => {
    if (!terms.every((term) => doc.lower.some((part) => part.includes(term)))) return;
    counts[doc.kind]++;
    if (kinds.size && !kinds.has(doc.kind)) return;
    total++;
    if (hits.length >= limit) return;
    // The part with the most terms, then the first one.
    let sub = 0;
    let best = -1;
    doc.lower.forEach((part, j) => {
      const n = terms.filter((term) => part.includes(term)).length;
      if (n > best) [best, sub] = [n, j];
    });
    hits.push({ i, sub, kind: doc.kind, label: doc.label, t: doc.t, snippet: snippet(doc.parts[sub], doc.lower[sub], terms) });
  });
  return { hits, counts, total };
}

function snippet(text: string, lower: string, terms: string[], width = 160): SearchHit["snippet"] {
  const first = Math.min(...terms.map((term) => lower.indexOf(term)).filter((x) => x >= 0));
  const start = Math.max(0, Math.min(first - 40, text.length - width));
  const end = Math.min(text.length, start + width);
  const window = text.slice(start, end).replace(/\s+/g, " ");
  const lw = window.toLowerCase();
  const runs: SearchHit["snippet"] = [];
  let pos = 0;
  while (pos < window.length) {
    let at = -1;
    let len = 0;
    for (const term of terms) {
      const k = lw.indexOf(term, pos);
      if (k >= 0 && (at < 0 || k < at || (k === at && term.length > len))) [at, len] = [k, term.length];
    }
    if (at < 0) break;
    if (at > pos) runs.push({ text: window.slice(pos, at), match: false });
    runs.push({ text: window.slice(at, at + len), match: true });
    pos = at + len;
  }
  if (pos < window.length) runs.push({ text: window.slice(pos), match: false });
  if (start > 0) runs.unshift({ text: "…", match: false });
  if (end < text.length) runs.push({ text: "…", match: false });
  return runs;
}
