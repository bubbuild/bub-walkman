import { useMemo, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Checkbox } from "@base-ui/react/checkbox";
import { Popover } from "@base-ui/react/popover";
import { ago, bytes } from "../format";
import { deleteTapes, useTapeList, useTicker, type TapeSummary } from "../hooks";
import { parsePrompt } from "../model";
import { Check, ChevronDown, ChevronRight, Minus, Search as SearchIcon, Trash } from "./icons";

const GROUPS = [
  { status: "running", label: "Running" },
  { status: "recent", label: "Active in the last hour" },
  { status: "idle", label: "Older" },
] as const;

/** Total size of tapes: bytes for files, entries for tapes in a Bub tape store (which has no byte sizes). */
function amount(items: Array<{ size: number | null; entries?: number }>): string {
  if (items.every((i) => i.size != null)) return bytes(items.reduce((n, i) => n + (i.size ?? 0), 0));
  const n = items.reduce((sum, i) => sum + (i.entries ?? 0), 0);
  return `${n.toLocaleString()} entr${n === 1 ? "y" : "ies"}`;
}

function describe(t: TapeSummary) {
  const p = parsePrompt(t.prompt);
  const headline = p.headline.replace(/\s+/g, " ").trim();
  const channel = p.meta.find((m) => m.startsWith("channel="))?.slice("channel=".length) ?? "";
  return { headline, channel };
}

function useFiltered(tapes: TapeSummary[] | null, filter: string) {
  return useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tapes || !terms.length) return tapes ?? [];
    return tapes.filter((t) => {
      const text = `${t.name}\n${t.prompt}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [tapes, filter]);
}

/** Management actions on the full tape list (not in the switcher popover). */
interface Manage {
  selecting: boolean;
  selected: Set<string>;
  onToggle: (name: string) => void;
  onDelete: (tape: TapeSummary) => void;
}

function TapeRow({
  tape,
  current,
  now,
  onPick,
  manage,
}: {
  tape: TapeSummary;
  current?: boolean;
  now: number;
  onPick: (name: string) => void;
  manage?: Manage;
}) {
  const { headline, channel } = describe(tape);
  const selecting = manage?.selecting ?? false;
  const checked = manage?.selected.has(tape.name) ?? false;
  const size = amount([tape, ...tape.sidecars]);
  return (
    <div className={`tape-row ${tape.status} ${current ? "current" : ""} ${checked ? "checked" : ""}`} data-tape={tape.name}>
      {selecting && (
        <Checkbox.Root
          className="cb"
          checked={checked}
          disabled={!tape.deletable}
          onCheckedChange={() => manage!.onToggle(tape.name)}
          aria-label={`Select ${tape.name}`}
        >
          <Checkbox.Indicator className="cb-ind">
            <Check size={12} />
          </Checkbox.Indicator>
        </Checkbox.Root>
      )}
      <button className="tape-open" onClick={() => (selecting ? tape.deletable && manage!.onToggle(tape.name) : onPick(tape.name))}>
        <span className="tape-dot" aria-hidden="true" />
        <span className="tape-main">
          <span className="tape-headline">{headline || <span className="muted">(no prompt)</span>}</span>
          <span className="tape-sub">
            <span className="mono">{tape.name}</span>
            {channel && <span>{channel}</span>}
            {tape.sidecars.length > 0 && (
              <span title={tape.sidecars.map((s) => s.name).join("\n")}>
                +{tape.sidecars.length} sidecar{tape.sidecars.length === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </span>
        <span className="tape-side">
          <span className="tape-when">{tape.status === "running" ? "running" : ago(tape.mtime * 1000, now)}</span>
          <span className="tape-size" title={tape.sidecars.length ? "tape and sidecars" : undefined}>
            {size}
          </span>
        </span>
      </button>
      {manage && !selecting && tape.deletable && (
        <button className="icon-btn tape-del" onClick={() => manage.onDelete(tape)} title="Delete tape and its sidecars" aria-label={`Delete ${tape.name}`}>
          <Trash size={15} />
        </button>
      )}
    </div>
  );
}

function TapeGroups({ tapes, current, onPick, manage }: { tapes: TapeSummary[]; current?: string; onPick: (name: string) => void; manage?: Manage }) {
  const now = useTicker(10_000);
  return (
    <>
      {GROUPS.map((g) => {
        const items = tapes.filter((t) => t.status === g.status);
        if (!items.length) return null;
        return (
          <section key={g.status} className="tape-group">
            <h3>
              {g.label} <span className="n">{items.length}</span>
            </h3>
            {items.map((t) => (
              <TapeRow key={t.name} tape={t} current={t.name === current} now={now} onPick={onPick} manage={manage} />
            ))}
          </section>
        );
      })}
    </>
  );
}

/** Confirms deleting tapes: lists every file that goes (tape + sidecars) and warns about running tapes. */
function DeleteDialog({ tapes, onClose, onDeleted }: { tapes: TapeSummary[]; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string> | null>(null);
  const running = tapes.filter((t) => t.status === "running");
  // Files on disk, or tapes in a Bub tape store (no size; they are reset there).
  const inStore = tapes.some((t) => t.size == null);
  const files = tapes.flatMap((t) => [{ name: inStore ? t.name : `${t.name}.jsonl`, size: t.size, entries: t.entries }, ...t.sidecars]);
  const one = tapes.length === 1;
  const confirm = async () => {
    setBusy(true);
    try {
      const result = await deleteTapes(
        tapes.map((t) => t.name),
        running.length > 0,
      );
      if (Object.keys(result.errors).length) {
        setErrors(result.errors);
        onDeleted(); // refresh: some may have gone
      } else {
        onDeleted();
        onClose();
      }
    } catch (err) {
      setErrors({ "": String(err instanceof Error ? err.message : err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog.Root open={tapes.length > 0} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Popup className="dialog">
          <AlertDialog.Title className="dialog-title">{one ? "Delete this tape?" : `Delete ${tapes.length} tapes?`}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-desc">
            {one ? "The tape and its sidecars" : "These tapes and their sidecars"}{" "}
            {inStore ? `are reset in the tape store (${files.length} tape${files.length === 1 ? "" : "s"}, ${amount(files)})` : `are removed from disk (${files.length} file${files.length === 1 ? "" : "s"}, ${amount(files)})`}.
            This cannot be undone.
          </AlertDialog.Description>
          {running.length > 0 && (
            <p className="dialog-warn">
              {running.map((t) => t.name).join(", ")} {running.length === 1 ? "is" : "are"} running. Bub may still be writing to{" "}
              {running.length === 1 ? "it" : "them"}.
            </p>
          )}
          <ul className="dialog-files">
            {files.map((f) => (
              <li key={f.name}>
                <span className="mono">{f.name}</span>
                <span className="size">{amount([f])}</span>
              </li>
            ))}
          </ul>
          {errors && (
            <ul className="dialog-errors">
              {Object.entries(errors).map(([name, msg]) => (
                <li key={name}>
                  {name && <span className="mono">{name}: </span>}
                  {msg}
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <AlertDialog.Close className="btn" disabled={busy}>
              {errors ? "Close" : "Cancel"}
            </AlertDialog.Close>
            {!errors && (
              <button className="btn danger" onClick={confirm} disabled={busy}>
                <Trash size={14} />
                {busy ? "Deleting…" : "Delete"}
              </button>
            )}
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function FilterBox({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="search-box tape-filter">
      <SearchIcon size={14} className="lead" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Filter by prompt or name" spellCheck={false} autoFocus={autoFocus} />
    </label>
  );
}

/** Full page shown when no tape is selected: every tape in Bub's tape directory, running ones first. */
export function TapePicker({ onPick }: { onPick: (name: string) => void }) {
  const { tapes, directory, error, reload } = useTapeList();
  const [filter, setFilter] = useState("");
  const shown = useFiltered(tapes, filter);
  const running = tapes?.filter((t) => t.status === "running").length ?? 0;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toDelete, setToDelete] = useState<TapeSummary[]>([]);
  const deletable = shown.filter((t) => t.deletable);
  const chosen = (tapes ?? []).filter((t) => selected.has(t.name));
  const allChosen = deletable.length > 0 && deletable.every((t) => selected.has(t.name));
  const someChosen = chosen.length > 0 && !allChosen;
  const manage: Manage = {
    selecting,
    selected,
    onToggle: (name) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(name)) next.add(name);
        return next;
      }),
    onDelete: (tape) => setToDelete([tape]),
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  return (
    <div className="app">
      <main className="main">
        <header className="topbar">
          <Brand />
          <div className="title">
            <div className="tape-name">Bub tapes</div>
            <div className="stats">
              <span className="dir" title={directory}>
                <bdi dir="ltr">{directory}</bdi>
              </span>
              {tapes && (
                <span>
                  <b>{tapes.length}</b> tapes
                </span>
              )}
              {running > 0 && (
                <span className="running-text">
                  <b>{running}</b> running
                </span>
              )}
            </div>
          </div>
        </header>
        <section className="timeline-wrap">
          <div className="tape-list">
            {/* One toolbar right above the list: filter on the left, Select (or the selection's actions) on the right. */}
            <div className="tape-toolbar">
              <FilterBox value={filter} onChange={setFilter} autoFocus />
              {selecting ? (
                <>
                  <button className="btn danger" disabled={!chosen.length} onClick={() => setToDelete(chosen)}>
                    <Trash size={14} />
                    Delete{chosen.length ? ` ${chosen.length}` : ""}
                  </button>
                  <button className="btn" onClick={stopSelecting}>
                    Done
                  </button>
                </>
              ) : (
                tapes?.some((t) => t.deletable) && (
                  <button className="btn" onClick={() => setSelecting(true)} title="Select tapes to delete">
                    Select
                  </button>
                )
              )}
            </div>
            {selecting && (
              <label className="check select-all">
                <Checkbox.Root
                  className="cb"
                  checked={allChosen}
                  indeterminate={someChosen}
                  onCheckedChange={() => setSelected(allChosen ? new Set() : new Set(deletable.map((t) => t.name)))}
                >
                  <Checkbox.Indicator className="cb-ind">{someChosen ? <Minus size={12} /> : <Check size={12} />}</Checkbox.Indicator>
                </Checkbox.Root>
                {filter ? "Select all shown" : "Select all"}
                {chosen.length > 0 && <span className="muted"> · {chosen.length} selected</span>}
              </label>
            )}
            {error && !tapes && <p className="empty-line">Could not list tapes: {error}</p>}
            {tapes && !tapes.length && <p className="empty-line">No tapes in {directory} yet.</p>}
            {tapes && tapes.length > 0 && !shown.length && <p className="empty-line">No tape matches “{filter}”.</p>}
            <TapeGroups tapes={shown} onPick={onPick} manage={manage} />
          </div>
        </section>
        <DeleteDialog
          tapes={toDelete}
          onClose={() => setToDelete([])}
          onDeleted={() => {
            reload();
            setSelected(new Set());
          }}
        />
      </main>
    </div>
  );
}

/**
 * Breadcrumb in the tape view's top bar: "Tapes / <tape> ▾". "Tapes" leads back to the tape list (and says how
 * many other tapes are running); the tape name opens a quick switcher.
 */
export function TapeCrumbs({ name, path, onPick, onHome }: { name: string; path?: string; onPick: (name: string) => void; onHome: () => void }) {
  const { tapes } = useTapeList();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = useFiltered(tapes, filter);
  const others = tapes?.filter((t) => t.status === "running" && t.name !== name).length ?? 0;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button className="crumb-home" onClick={onHome} title="All tapes: browse, filter and delete">
        Tapes
        {others > 0 && (
          <span className="others" title={`${others} other tape${others === 1 ? "" : "s"} running`}>
            <span className="tape-dot" />
            {others} running
          </span>
        )}
      </button>
      <span className="crumb-sep" aria-hidden="true">
        /
      </span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className="tape-switch" title={path ? `${path}\nSwitch tape` : "Switch tape"} aria-label="Switch tape">
          <span className="tape-name">{name}</span>
          <ChevronDown size={14} className="chev" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner className="pop-pos" sideOffset={8} align="start">
            <Popover.Popup className="pop tape-pop">
              <div className="tape-pop-head">
                <FilterBox value={filter} onChange={setFilter} autoFocus />
              </div>
              <div className="tape-pop-list">
                {!tapes && <p className="empty-line">Loading…</p>}
                <TapeGroups
                  tapes={shown}
                  current={name}
                  onPick={(n) => {
                    setOpen(false);
                    setFilter("");
                    if (n !== name) onPick(n);
                  }}
                />
              </div>
              <button
                className="tape-pop-all"
                onClick={() => {
                  setOpen(false);
                  onHome();
                }}
              >
                All tapes
                <ChevronRight size={14} />
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </nav>
  );
}

export function Brand() {
  return (
    <div className="brand" title="bub-walkman">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="7" width="26" height="18" rx="3" />
        <circle className="reel" cx="11" cy="16" r="3.5" />
        <circle className="reel" cx="21" cy="16" r="3.5" />
      </svg>
    </div>
  );
}
