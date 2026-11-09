import { Fragment, memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { chars, dayOf, duration, timeOfDay, tokens } from "../format";
import { apiUrl, useNow } from "../hooks";
import { CodeBlock } from "./CodeBlock";
import { Check, ChevronRight, Circle, Diamond, Dot } from "./icons";
import {
  parseArgs,
  parsePrompt,
  summarizeArgs,
  viewResult,
  type Block,
  type Item,
  type Step,
  type ToolCall,
  type Turn,
} from "../model";

export interface ViewOptions {
  system: boolean;
  reasoning: boolean;
  events: boolean;
  expandTools: boolean;
}

const PREVIEW_LIMIT = 20_000;

/** An entry the user asked to reveal; `n` changes on every request so repeated picks re-trigger. */
export interface Focus {
  i: number;
  n: number;
  /** For search hits: what matched, so the exact tool call / result / reasoning can be revealed. */
  kind?: string;
  sub?: number;
}

/** Left pane: one compact row per item (turns, anchors, top-level commands/events), grouped by day. */
export function TurnList({
  items,
  opts,
  selected,
  onSelect,
  version,
}: {
  items: Item[];
  opts: ViewOptions;
  selected: string | null;
  onSelect: (item: Item) => void;
  version: number;
}) {
  let prevDay = "";
  return (
    <nav className="turn-list" data-version={version} aria-label="Turns">
      {items.map((item) => {
        if (item.type === "misc" && item.kind === "event" && !opts.events) return null;
        const day = dayOf(item.t0);
        const showDay = day !== prevDay;
        prevDay = day;
        return (
          <Fragment key={item.id}>
            {showDay && <div className="day-sep">{day}</div>}
            <ListRow item={item} v={item.v} active={item.id === selected} onSelect={onSelect} />
          </Fragment>
        );
      })}
    </nav>
  );
}

const ListRow = memo(function ListRow({ item, active, onSelect }: { item: Item; v: number; active: boolean; onSelect: (item: Item) => void }) {
  const cls = `li ${item.type} ${item.type === "turn" ? item.status : ""} ${active ? "active" : ""}`;
  const props = { className: cls, onClick: () => onSelect(item), "data-item": item.id, "aria-current": active || undefined };
  if (item.type === "anchor") {
    return (
      <button {...props}>
        <Diamond size={11} />
        <span className="li-anchor">{item.name}</span>
        <span className="li-time">{timeOfDay(item.t0)}</span>
      </button>
    );
  }
  if (item.type === "misc") {
    const label = item.kind === "command" ? `$ ${String(item.data?.raw ?? item.data?.name ?? "command")}` : item.name;
    return (
      <button {...props}>
        <span className="li-misc">{label}</span>
        <span className="li-time">{timeOfDay(item.t0)}</span>
      </button>
    );
  }
  const turn = item;
  const prompt = parsePrompt(turn.prompt);
  const running = turn.status === "running";
  return (
    <button {...props}>
      <span className="li-dot" />
      <span className="li-main">
        <span className="li-title">{prompt.headline.replace(/\s+/g, " ").trim() || <span className="muted">(no prompt)</span>}</span>
        <span className="li-meta">
          {turn.status !== "ok" && <span className={`state ${turn.status}`}>{turn.status}</span>}
          <span>
            {turn.steps.length} step{turn.steps.length === 1 ? "" : "s"}
          </span>
          {turn.toolCount > 0 && <span>{turn.toolCount} tools</span>}
          <span>{running ? <Elapsed since={turn.t0} /> : duration((turn.t1 ?? turn.t0) - turn.t0)}</span>
        </span>
      </span>
      <span className="li-time">{timeOfDay(turn.t0)}</span>
    </button>
  );
});

/** Right pane: the selected item in full. */
export function ItemDetail({ item, opts }: { item: Item | null; v: number; opts: ViewOptions }) {
  if (!item) return null;
  if (item.type === "turn") return <TurnDetail turn={item} opts={opts} />;
  return (
    <article className="detail-misc" id={item.id} data-entry={item.i0}>
      <div className="detail-time">
        {dayOf(item.t0)} {timeOfDay(item.t0)}
      </div>
      {item.type === "anchor" ? (
        <AnchorLine name={item.name} state={item.state} icon />
      ) : item.kind === "command" ? (
        <CommandBlock data={item.data} />
      ) : (
        <EventLine name={item.name} data={item.data} />
      )}
    </article>
  );
}

function TurnDetail({ turn, opts }: { turn: Turn; opts: ViewOptions }) {
  const prompt = parsePrompt(turn.prompt);
  const running = turn.status === "running";
  const lastStep = turn.steps[turn.steps.length - 1];
  return (
    <article className={`turn-detail ${turn.status}`} id={turn.id} data-entry={turn.i0}>
      <header className="turn-head">
        <div className="detail-time">
          {dayOf(turn.t0)} {timeOfDay(turn.t0)}
          {turn.t1 != null && !running && ` – ${timeOfDay(turn.t1)}`}
        </div>
        <h2 className="prompt">{prompt.headline || <span className="muted">(no prompt)</span>}</h2>
        <div className="meta">
          {turn.status !== "ok" && <span className={`state ${turn.status}`}>{turn.status}</span>}
          {turn.model && <span className="mono">{turn.model}</span>}
          <span>
            {turn.steps.length} step{turn.steps.length === 1 ? "" : "s"}
          </span>
          {turn.toolCount > 0 && <span>{turn.toolCount} tool calls</span>}
          <span>{running ? <Elapsed since={turn.t0} /> : duration((turn.t1 ?? turn.t0) - turn.t0)}</span>
          {turn.usage.input > 0 && <span title="peak context tokens">ctx {tokens(turn.usage.input)}</span>}
          {turn.usage.input > 0 && <span title="output tokens">out {tokens(turn.usage.output)}</span>}
          {turn.usage.input > 0 && turn.usage.cached > 0 && (
            <span title="cache hit of last call">cache {Math.round((turn.usage.cached / Math.max(1, lastStep?.usage?.input ?? turn.usage.input)) * 100)}%</span>
          )}
          {(prompt.meta.length > 0 || turn.implicit) && (
            <span className="origin" title={[turn.implicit ? "no loop events" : "", ...prompt.meta].filter(Boolean).join("\n")}>
              {[turn.implicit ? "no loop events" : "", ...prompt.meta].filter(Boolean).join("  ")}
            </span>
          )}
        </div>
        {turn.error && (
          <div className="turn-error" title={turn.error}>
            {turn.error}
          </div>
        )}
        {running ? <LiveWaterfall turn={turn} /> : <Waterfall turn={turn} now={turn.t1 ?? turn.t0} />}
      </header>
      <div className="steps">
        {prompt.body !== prompt.headline || prompt.body.length > 600 ? (
          <details className="block sys full-prompt">
            <summary>
              <ChevronRight className="disc" size={14} />
              Full prompt · {chars(turn.prompt ?? "")}
            </summary>
            <CodeBlock>{turn.prompt}</CodeBlock>
          </details>
        ) : null}
        {turn.steps.map((step, i) => (
          <StepView key={step.key} step={step} turn={turn} opts={opts} last={i === turn.steps.length - 1} />
        ))}
        {!running && turn.status !== "unknown" && (
          <div className={`finish ${turn.status}`}>
            <div className="step-head">
              <span className="sn">{turn.status === "ok" ? "Done" : turn.status === "error" ? "Failed" : turn.status === "cancelled" ? "Cancelled" : turn.status}</span>
              {turn.error && turn.error !== lastStep?.error && <span className="err">{turn.error}</span>}
              <span className="spacer" />
              <span className="time">{timeOfDay(turn.t1 ?? turn.t0)}</span>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function AnchorLine({ name, state, icon = false }: { name: string; state?: unknown; icon?: boolean }) {
  const hasState = state != null && !(typeof state === "object" && Object.keys(state as object).length === 0);
  return (
    <div className="anchor-line">
      {icon && <Diamond size={12} />}
      <span className="name">{name}</span>
      {hasState && <span className="state">{JSON.stringify(state)}</span>}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const now = useNow();
  return <span data-running>{duration(Math.max(0, now - since))}</span>;
}

function LiveWaterfall({ turn }: { turn: Turn }) {
  return <Waterfall turn={turn} now={useNow()} />;
}

function Waterfall({ turn, now }: { turn: Turn; now: number }) {
  if (!turn.steps.length) return null;
  const end = Math.max(turn.t1 ?? now, ...turn.steps.map((s) => s.t1 ?? now));
  const span = Math.max(1, end - turn.t0);
  return (
    <div className="wf">
      {turn.steps.map((s) => {
        const left = ((s.t0 - turn.t0) / span) * 100;
        const width = (((s.t1 ?? now) - s.t0) / span) * 100;
        const cls = [s.status, s.toolCount ? "tools" : ""].join(" ");
        const title = `step ${s.n} · ${s.status} · ${duration((s.t1 ?? now) - s.t0)}${s.toolCount ? ` · ${s.toolCount} tool calls` : ""}`;
        return (
          <i
            key={s.key}
            className={cls}
            style={{ left: `${left}%`, width: `${Math.max(width, 0.3)}%` }}
            title={title}
            onClick={() => {
              const el = document.getElementById(s.key);
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
              el?.classList.remove("flash");
              void el?.offsetWidth;
              el?.classList.add("flash");
            }}
          />
        );
      })}
    </div>
  );
}

// -- step ----------------------------------------------------------------

function StepView({ step, turn, opts, last }: { step: Step; turn: Turn; opts: ViewOptions; last: boolean }) {
  const running = step.status === "running";
  return (
    <div className={`step ${step.status}`} id={step.key} data-entry={step.i0}>
      <div className="step-head">
        <span className="sn">Step {step.n}</span>
        <span className="meta">
          <span>{running ? <Elapsed since={step.t0} /> : duration((step.t1 ?? step.t0) - step.t0)}</span>
          {(step.status === "error" || step.status === "cancelled") && <span className={`state ${step.status}`}>{step.status}</span>}
          {step.usage && <span title="input tokens">in {tokens(step.usage.input)}</span>}
          {step.usage && <span title="output tokens">out {tokens(step.usage.output)}</span>}
          {step.model && step.model !== turn.model && <span className="mono">{step.model}</span>}
        </span>
        <span className="spacer" />
        <span className="time">{timeOfDay(step.t0)}</span>
      </div>
      {step.blocks.map((block) => (
        <BlockView key={block.key} block={block} turn={turn} opts={opts} />
      ))}
      {running && (
        <div className="waiting">
          <span className="spinner" />
          {last && turn.status === "running" ? "Waiting for model" : "Running"}
        </div>
      )}
      {step.error && <div className="step-error">{step.error}</div>}
    </div>
  );
}

function BlockView({ block, turn, opts }: { block: Block; turn: Turn; opts: ViewOptions }) {
  switch (block.type) {
    case "system":
      if (!opts.system) return null;
      return (
        <details className="block sys" data-entry={block.i}>
          <summary>
            <ChevronRight className="disc" size={14} />
            System prompt · {chars(block.content)}
          </summary>
          <CodeBlock>{block.content}</CodeBlock>
        </details>
      );
    case "message":
      if (block.role === "user" && block.content === turn.prompt) return null;
      return (
        <div className="block" data-entry={block.i}>
          {opts.reasoning && block.reasoning && <Reasoning text={block.reasoning} />}
          <Message role={block.role} content={block.role === "user" ? parsePrompt(block.content).body : block.content} />
        </div>
      );
    case "tools":
      return (
        <div className="block" data-entry={block.i}>
          {opts.reasoning && block.reasoning && <Reasoning text={block.reasoning} />}
          {block.content && <Message role="assistant" content={block.content} />}
          <div className="tools">
            {block.calls.map((call, j) => (
              <ToolView key={`${call.id}-${opts.expandTools}`} call={call} defaultOpen={opts.expandTools} entry={block.i} sub={j} />
            ))}
          </div>
        </div>
      );
    case "results":
      return (
        <div className="block" data-entry={block.i}>
          {block.results.map((r, i) => (
            <Output key={i} label="Orphan tool result" result={r} />
          ))}
        </div>
      );
    case "plan":
      return (
        <div className="block" data-entry={block.i}>
          <ul className="plan">
            {block.entries.map((p, i) => (
              <li key={i} className={p.status}>
                <span className="st">{p.status === "completed" ? <Check size={14} /> : p.status === "in_progress" ? <Dot size={14} /> : <Circle size={14} />}</span>
                <span>{p.content}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "anchor":
      return (
        <div className="block" data-entry={block.i}>
          <AnchorLine name={block.name} state={block.state} icon />
        </div>
      );
    case "command":
      return (
        <div className="block" data-entry={block.i}>
          <CommandBlock data={block.data} />
        </div>
      );
    case "event":
      if (!opts.events) return null;
      return (
        <div className="block" data-entry={block.i}>
          <EventLine name={block.name} data={block.data} />
        </div>
      );
  }
}

function Message({ role, content }: { role: string; content: string }) {
  if (!content.trim()) return null;
  return (
    <div className={`msg ${role}`}>
      {role !== "assistant" && <span className="who">{role === "user" ? "User" : role}</span>}
      <LongText text={content} render={(t) => <Markdown text={t} />} />
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const first = text.trim().split("\n")[0].replace(/\*\*|__|`/g, "").slice(0, 140);
  return (
    <details className="reasoning">
      <summary>
        <span className="first">
          {first}
          {text.length > first.length ? "…" : ""}
        </span>
      </summary>
      {text}
    </details>
  );
}

function LongText({ text, render }: { text: string; render: (t: string) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  if (all || text.length <= PREVIEW_LIMIT) return <>{render(text)}</>;
  return (
    <>
      {render(text.slice(0, PREVIEW_LIMIT))}
      <button className="linkbtn" onClick={() => setAll(true)}>
        … show all {chars(text)}
      </button>
    </>
  );
}

// -- tools ---------------------------------------------------------------

function ToolView({ call, defaultOpen, entry, sub }: { call: ToolCall; defaultOpen: boolean; entry?: number; sub: number }) {
  const [open, setOpen] = useState(defaultOpen);
  const result = call.done ? viewResult(call.result) : null;
  const summary = summarizeArgs(call.args);
  const lines = result ? result.text.split("\n").length : 0;
  const cls = ["tool", !call.done ? "pending" : "", result?.failed ? "failed" : ""].join(" ");
  return (
    <details
      className={cls}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      data-entry={entry}
      data-sub={sub}
      data-result={call.ri}
      data-rsub={call.rj}
    >
      <summary>
        <ChevronRight className="disc" size={14} />
        <span className="tname">{call.name}</span>
        <span className="targ">{summary}</span>
        <span className="tres">
          {!call.done ? "waiting" : result!.failed ? "failed" : result!.spill ? "spilled" : `${lines} line${lines === 1 ? "" : "s"}`}
        </span>
      </summary>
      {open && (
        <div className="tool-body">
          <Args args={call.args} />
          {call.done ? <Output label="Result" result={call.result} /> : <div className="note">Waiting for result…</div>}
        </div>
      )}
    </details>
  );
}

function Args({ args }: { args: string }) {
  const parsed = parseArgs(args);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (!entries.length) return <div className="note">No arguments</div>;
    return (
      <div className="kv">
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <span className="k">{k}</span>
            <span className="v">{typeof v === "string" ? v : JSON.stringify(v, null, 2)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <pre className="kv v">{String(parsed)}</pre>;
}

function Output({ label, result }: { label: string; result: unknown }) {
  const view = viewResult(result);
  const [spill, setSpill] = useState<{ state: "idle" | "loading" | "error"; text?: string; error?: string }>({ state: "idle" });
  const load = async () => {
    setSpill({ state: "loading" });
    try {
      const res = await fetch(apiUrl(`/api/spill/${view.spill}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setSpill({ state: "idle", text: data.content });
    } catch (err) {
      setSpill({ state: "error", error: String(err instanceof Error ? err.message : err) });
    }
  };
  const text = spill.text ?? view.text;
  return (
    <div className={`out ${view.failed ? "err" : ""}`}>
      <div className="lbl">
        {label} · {chars(text)}
        {view.spill && spill.text == null && (
          <button className="linkbtn" onClick={load} disabled={spill.state === "loading"}>
            {spill.state === "loading" ? "loading…" : "load full spilled output"}
          </button>
        )}
        {spill.error && <span className="err-text">{spill.error}</span>}
      </div>
      <LongText text={text} render={(t) => <CodeBlock text={text}>{t}</CodeBlock>} />
    </div>
  );
}

function CommandBlock({ data }: { data: Record<string, unknown> }) {
  const output = typeof data.output === "string" ? data.output : "";
  return (
    <details className="tool">
      <summary>
        <ChevronRight className="disc" size={14} />
        <span className="tname">$ {String(data.raw ?? data.name ?? "command")}</span>
        <span className="targ" />
        <span className="tres">
          {String(data.status ?? "")} {typeof data.elapsed_ms === "number" ? duration(data.elapsed_ms) : ""}
        </span>
      </summary>
      {output && (
        <div className="tool-body">
          <div className="out">
            <CodeBlock>{output}</CodeBlock>
          </div>
        </div>
      )}
    </details>
  );
}

function EventLine({ name, data }: { name: string; data: unknown }) {
  const text = data == null ? "" : JSON.stringify(data);
  return (
    <div className="note">
      <span className="ename">{name}</span> <span className="mono">{text.length > 300 ? `${text.slice(0, 300)}…` : text}</span>
    </div>
  );
}
