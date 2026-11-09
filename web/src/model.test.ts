import { describe, expect, it } from "vitest";
import { SearchIndex, Timeline, countAt, parsePrompt, playbackTimes, search, summarizeArgs, viewResult, type Entry, type SearchKind, type Turn } from "./model";

let id = 0;
const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 0, 0, s)).toISOString();
const ev = (s: number, name: string, data: object = {}): Entry => ({ id: ++id, kind: "event", payload: { name, data }, date: at(s) });
const entry = (s: number, kind: string, payload: object): Entry => ({ id: ++id, kind, payload, date: at(s) });

function build(entries: Entry[]): Timeline {
  const tl = new Timeline();
  tl.pushAll(entries);
  return tl;
}

describe("Timeline", () => {
  const turn = [
    entry(0, "anchor", { name: "session/start", state: { owner: "human" } }),
    ev(0, "handoff", { name: "session/start" }),
    ev(1, "loop.start", { model: "m:x", prompt: "channel=$cli|chat_id=1\n---Date: 2026---\nhello" }),
    ev(1, "loop.step.start", { step: 1 }),
    entry(5, "system", { content: "sys" }),
    entry(5, "message", { role: "user", content: "channel=$cli|chat_id=1\n---Date: 2026---\nhello" }),
    entry(5, "tool_call", {
      calls: [
        { id: "a", function: { name: "bash", arguments: '{"cmd":"ls"}' }, type: "function" },
        { id: "b", name: "fs_read", arguments: '{"path":"/x"}' },
      ],
    }),
    entry(5, "tool_result", { results: ["file", { kind: "tool", message: "Tool 'fs_read' execution failed.", details: { error: "nope" } }] }),
    ev(5, "run", { status: "ok", usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 90 } }, model: "m:x" }),
    ev(5, "loop.step", { step: 1, status: "continue", elapsed_ms: 4000, date: at(5) }),
    ev(5, "loop.step.start", { step: 2 }),
    entry(9, "message", { role: "assistant", content: "done", reasoning: "think" }),
    ev(9, "run", { status: "ok", usage: { input_tokens: 120, output_tokens: 3 } }),
    ev(9, "loop.step", { step: 2, status: "ok", elapsed_ms: 4000, date: at(9) }),
    ev(9, "loop.finish", { status: "ok", steps: 2, elapsed_ms: 8000, date: at(9) }),
  ];

  it("folds a full turn into steps with paired tool results", () => {
    const tl = build(turn);
    expect(tl.items.map((i) => i.type)).toEqual(["anchor", "turn"]);
    const t = tl.items[1] as Turn;
    expect(t.status).toBe("ok");
    expect(t.t1! - t.t0).toBe(8000);
    expect(t.steps.map((s) => [s.n, s.status, s.t1! - s.t0])).toEqual([
      [1, "continue", 4000],
      [2, "ok", 4000],
    ]);
    const tools = t.steps[0].blocks.find((b) => b.type === "tools");
    expect(tools?.type === "tools" && tools.calls.map((c) => [c.name, c.done])).toEqual([
      ["bash", true],
      ["fs_read", true],
    ]);
    expect(t.usage).toEqual({ input: 120, output: 10, cached: 0 });
    expect(tl.stats).toMatchObject({ turns: 1, steps: 2, tools: 2, output: 10 });
  });

  it("shows a started step as running until it ends", () => {
    const tl = build(turn.slice(0, 4));
    const t = tl.openTurn!;
    expect(t.status).toBe("running");
    expect(t.steps[0].status).toBe("running");
    expect(t.steps[0].t1).toBeNull();
  });

  it("marks a turn interrupted by a new loop.start as unfinished", () => {
    const tl = build([...turn.slice(2, 4), ev(20, "loop.start", { prompt: "again" })]);
    const [first, second] = tl.items as Turn[];
    expect(first.status).toBe("unfinished");
    expect(first.steps[0].status).toBe("unfinished");
    expect(second.status).toBe("running");
  });

  it("supports incremental and from-scratch building identically", () => {
    const a = build(turn);
    const b = new Timeline();
    for (let i = 1; i <= turn.length; i++) b.pushAll(turn, i);
    expect(b.items).toEqual(a.items);
  });

  it("wraps entries without loop events in an implicit turn", () => {
    const tl = build([entry(0, "message", { role: "user", content: "hi" }), entry(1, "message", { role: "assistant", content: "yo" })]);
    const t = tl.items[0] as Turn;
    expect(t.implicit).toBe(true);
    expect(t.prompt).toBe("hi");
    expect(t.status).toBe("unknown");
  });

  it("settles a turn on its terminal step when loop.finish is missing", () => {
    const tl = build([...turn.slice(2, 14), ev(30, "loop.start", { prompt: "next" })]);
    const first = tl.items[0] as Turn;
    expect(first.status).toBe("ok");
    expect(first.t1! - first.t0).toBe(8000);
    const reopened = build([...turn.slice(2, 14), ev(10, "loop.step.start", { step: 3 })]).items[0] as Turn;
    expect(reopened.status).toBe("running");
  });

  it("records loop.step errors", () => {
    const tl = build([ev(0, "loop.start"), ev(0, "loop.step.start", { step: 1 }), ev(1, "loop.step", { step: 1, status: "error", error: "401", date: at(1) })]);
    const t = tl.items[0] as Turn;
    expect(t.steps[0]).toMatchObject({ status: "error", error: "401" });
    expect(tl.stats.errors).toBe(1);
  });
});

describe("playback", () => {
  it("caps idle gaps and counts visible entries", () => {
    const entries = [entry(0, "x", {}), entry(1, "x", {}), entry(100, "x", {}), entry(100, "x", {})];
    const pt = playbackTimes(entries, 2000);
    expect(pt).toEqual([0, 1000, 3000, 3000]);
    expect(countAt(pt, 0)).toBe(1);
    expect(countAt(pt, 2999)).toBe(2);
    expect(countAt(pt, 3000)).toBe(4);
    expect(playbackTimes(entries, Infinity)[2]).toBe(100_000);
  });
});

describe("helpers", () => {
  it("splits bub's channel header from the prompt", () => {
    expect(parsePrompt("channel=$acp|chat_id=1\n---Date: 2026-11-09---\nhello\n")).toEqual({
      meta: ["channel=$acp", "chat_id=1"],
      date: "2026-11-09",
      body: "hello",
      headline: "hello",
    });
    expect(parsePrompt("<sys>x</sys>\n<user_request>\n发布1.0版本\n</user_request>\ntail").headline).toBe("发布1.0版本");
    expect(parsePrompt("plain text").meta).toEqual([]);
    const t3 = "你觉得现在改合适吗？\n<runtime_info>\nYou are running in T3.\n</runtime_info>\n<pull_request_linking>\nlink PRs\n</pull_request_linking>";
    expect(parsePrompt(t3)).toMatchObject({ headline: "你觉得现在改合适吗？", body: t3 });
    expect(parsePrompt("<runtime_info>only</runtime_info>").headline).toBe("<runtime_info>only</runtime_info>");
    expect(parsePrompt("a <b>x</b> and <Tag>y</Tag>").headline).toBe("a  and <Tag>y</Tag>");
  });

  it("summarizes tool arguments by their most telling field", () => {
    expect(summarizeArgs('{"max_results": 5, "query": "acp  registry"}')).toBe("acp registry");
    expect(summarizeArgs("{}")).toBe("");
    expect(summarizeArgs("not json")).toBe("not json");
  });

  it("detects failures and spill handles in results", () => {
    expect(viewResult({ kind: "tool", message: "failed", details: { error: "boom" } })).toMatchObject({ failed: true, text: "failed\nboom" });
    expect(viewResult("[tool output spilled: 1 bytes; handle: 0f271c3b2cb4417eab62582d6cf11166]").spill).toBe("0f271c3b2cb4417eab62582d6cf11166");
  });
});

describe("search", () => {
  const entries = [
    entry(0, "anchor", { name: "phase/plan", state: { owner: "agent" } }),
    entry(1, "message", { role: "user", content: "Please Deploy the 服务" }),
    entry(2, "message", { role: "assistant", content: "ok", reasoning: "think about deploy targets" }),
    entry(3, "tool_call", { calls: [{ id: "a", function: { name: "bash", arguments: '{"cmd":"kubectl apply -f deploy.yaml"}' } }, { id: "b", name: "fs_read", arguments: '{"path":"/srv/服务.md"}' }] }),
    entry(4, "tool_result", { results: ["applied", { content: "deployment.apps/web configured" }] }),
    ev(5, "loop.step", { status: "error", error: "Deploy timed out" }),
  ];
  const index = new SearchIndex();
  index.update(entries.slice(0, 3));
  index.update(entries); // incremental
  const run = (q: string, kinds: SearchKind[] = []) => search(index, q, new Set(kinds));

  it("matches case-insensitively across kinds, in tape order", () => {
    const r = run("DEPLOY");
    expect(r.hits.map((h) => h.i)).toEqual([1, 2, 3, 4, 5]);
    expect(r.counts).toMatchObject({ message: 2, tool_call: 1, tool_result: 1, event: 1, anchor: 0 });
  });

  it("filters by kind while still counting every kind", () => {
    const r = run("deploy", ["tool_call", "tool_result"]);
    expect(r.hits.map((h) => h.kind)).toEqual(["tool_call", "tool_result"]);
    expect(r.total).toBe(2);
    expect(r.counts.message).toBe(2);
  });

  it("requires every term and points at the matching part", () => {
    expect(run("deploy 服务").hits.map((h) => h.i)).toEqual([1, 3]);
    const call = run("服务", ["tool_call"]).hits[0];
    expect(call).toMatchObject({ i: 3, sub: 1, label: "bash, fs_read" });
    expect(run("configured").hits[0]).toMatchObject({ i: 4, sub: 1, label: "bash, fs_read" });
    expect(run("targets").hits[0]).toMatchObject({ i: 2, sub: 1 });
  });

  it("builds a snippet with the matches marked", () => {
    const hit = run("deploy").hits[0];
    expect(hit.snippet.filter((r) => r.match).map((r) => r.text)).toEqual(["Deploy"]);
    expect(hit.snippet.map((r) => r.text).join("")).toBe("Please Deploy the 服务");
    expect(run("   ").hits).toEqual([]);
  });

  it("keeps quoted phrases together", () => {
    expect(run('"deploy the"').hits.map((h) => h.i)).toEqual([1]);
    expect(run('"apply -f" bash').hits.map((h) => h.i)).toEqual([3]);
  });

  it("marks entries with their source index in the timeline", () => {
    const tl = new Timeline();
    tl.pushAll([ev(0, "loop.start", {}), ev(0, "loop.step.start", { step: 1 }), ...entries.slice(1, 5)]);
    const step = (tl.items[0] as Turn).steps[0];
    expect(step.i0).toBe(1);
    expect(step.blocks.map((b) => b.i)).toEqual([2, 3, 4]);
    const tools = step.blocks[2];
    expect(tools.type === "tools" && tools.calls.map((c) => [c.ri, c.rj])).toEqual([[5, 0], [5, 1]]);
  });
});
