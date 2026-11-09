"""Locating and reading Bub tape files (JSONL, one entry per line)."""

import contextlib
import glob
import json
import os
import re
import time
from pathlib import Path
from typing import Any

SIDECAR_MARK = "__sidecar__"

type Entry = dict[str, Any]
"""One tape entry: ``{id, kind, payload, meta, date}``."""


def sidecar_path(tape: Path, sidecar: str) -> Path:
    """Path of a sidecar tape stored next to ``tape`` (e.g. the spill sidecar)."""
    base = tape.stem.split(SIDECAR_MARK)[0]
    return tape.with_name(f"{base}{SIDECAR_MARK}{sidecar}.jsonl")


def parse_lines(data: bytes) -> list[Entry]:
    entries: list[Entry] = []
    for raw in data.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


class TapeReader:
    """Incremental reader that only consumes complete lines and detects resets."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.offset = 0
        self._ident: tuple[int, int] | None = None

    def resume(self, offset: int, st: os.stat_result) -> None:
        self.offset = offset
        self._ident = (st.st_dev, st.st_ino)

    def poll(self) -> tuple[bool, list[Entry]]:
        """Return (reset, new_entries). ``reset`` means the file was truncated or replaced."""
        try:
            st = self.path.stat()
        except FileNotFoundError:
            reset = self.offset > 0
            self.offset, self._ident = 0, None
            return reset, []
        ident = (st.st_dev, st.st_ino)
        reset = False
        if (self._ident is not None and ident != self._ident) or st.st_size < self.offset:
            reset = self.offset > 0
            self.offset = 0
        self._ident = ident
        if st.st_size == self.offset:
            return reset, []
        with self.path.open("rb") as f:
            f.seek(self.offset)
            chunk = f.read(st.st_size - self.offset)
        end = chunk.rfind(b"\n")
        if end < 0:
            return reset, []
        self.offset += end + 1
        return reset, parse_lines(chunk[: end + 1])


def read_all(path: Path) -> tuple[list[Entry], int]:
    reader = TapeReader(path)
    _, entries = reader.poll()
    return entries, reader.offset


def read_spill(path: Path, handle: str) -> dict[str, Any]:
    """Collect the chunks of one spilled tool output from a spill sidecar tape file."""
    return collect_spill(read_all(path)[0], handle)


def collect_spill(entries: list[Entry], handle: str) -> dict[str, Any]:
    """Collect the chunks of one spilled tool output from the entries of a spill sidecar tape."""
    chunks: dict[int, str] = {}
    current: int | None = None
    prefix = f"spill/{handle}/chunk/"
    for entry in entries:
        kind = entry.get("kind")
        payload = entry.get("payload") or {}
        meta = entry.get("meta") or {}
        if kind == "anchor":
            name = str(payload.get("name", ""))
            current = int(name[len(prefix) :]) if name.startswith(prefix) and name[len(prefix) :].isdigit() else None
            continue
        index = current
        if meta.get("spill_handle") == handle and isinstance(meta.get("spill_chunk"), int):
            index = meta["spill_chunk"]
        if index is None or kind != "tool_result":
            continue
        for result in payload.get("results") or []:
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
            chunks[index] = chunks.get(index, "") + text
        current = None
    ordered = [chunks[i] for i in sorted(chunks)]
    return {"handle": handle, "chunks": len(ordered), "content": "".join(ordered)}


# -- discovery ----------------------------------------------------------------

TAIL_BYTES = 256 * 1024
PROMPT_CHARS = 4000
RUNNING_WINDOW = 15 * 60  # an open turn only counts as running if the tape was written this recently
RECENT_WINDOW = 60 * 60

type TapeSummary = dict[str, Any]


def is_main_tape(path: Path) -> bool:
    return path.suffix == ".jsonl" and SIDECAR_MARK not in path.stem


def sidecars_of(tape: Path) -> list[Path]:
    """Every sidecar tape of ``tape`` (``<tape>__sidecar__<name>.jsonl``, including sidecars of sidecars)."""
    return sorted(tape.parent.glob(f"{glob.escape(tape.stem)}{SIDECAR_MARK}*.jsonl"))


def _tail_entries(path: Path, size: int) -> list[Entry]:
    with path.open("rb") as f:
        start = max(0, size - TAIL_BYTES)
        f.seek(start)
        chunk = f.read(size - start)
    if start:
        chunk = chunk[chunk.find(b"\n") + 1 :]  # drop the partial first line
    return parse_lines(chunk)


_USER_REQUEST = re.compile(r"<user_request>.*?</user_request>", re.S)


def _short_prompt(prompt: str) -> str:
    """Enough of a prompt for a headline: the channel line plus the <user_request> block when the prompt is wrapped."""
    if len(prompt) <= PROMPT_CHARS:
        return prompt
    if m := _USER_REQUEST.search(prompt):
        head = prompt.split("\n", 1)[0]
        return f"{head}\n{m.group(0)[:PROMPT_CHARS]}"
    return prompt[:PROMPT_CHARS]


def _scan(path: Path, size: int) -> TapeSummary:
    return scan_entries(_tail_entries(path, size))


def scan_entries(entries: list[Entry]) -> TapeSummary:
    """What the tail of a tape says about its latest turn: whether it is still open, and its prompt."""
    open_turn: bool | None = None
    prompt = ""
    last = ""
    for entry in entries:
        last = str(entry.get("date") or last)
        if entry.get("kind") != "event":
            continue
        payload = entry.get("payload") or {}
        data = payload.get("data") or {}
        match payload.get("name"):
            case "loop.start":
                open_turn = True
                prompt = _short_prompt(str(data.get("prompt") or ""))
            case "loop.step.start":
                open_turn = True
            case "loop.step" if data.get("status", "ok") != "continue":
                open_turn = False  # a terminal step ends the loop (older Bub never writes loop.finish)
            case "loop.finish":
                open_turn = False
    return {"open": bool(open_turn), "prompt": prompt, "last": last}


def tape_status(open_turn: bool, age: float) -> str:
    """running: an open turn written to recently; recent: written to within the hour; else idle."""
    return "running" if open_turn and age < RUNNING_WINDOW else "recent" if age < RECENT_WINDOW else "idle"


def sort_summaries(summaries: list[TapeSummary]) -> list[TapeSummary]:
    rank = {"running": 0, "recent": 1, "idle": 2}
    summaries.sort(key=lambda t: (rank[t["status"]], -t["mtime"]))
    return summaries


class TapeDirectory:
    """Lists the tapes in Bub's tape directory, with a cached tail scan per file version."""

    def __init__(self, directory: Path, extra: Path | None = None) -> None:
        self.directory = directory
        # A tape given on the command line may live outside the directory.
        self.extra = extra if extra is not None and extra.parent.resolve() != directory.resolve() else None
        self._cache: dict[Path, tuple[tuple[int, int], TapeSummary]] = {}

    def resolve(self, name: str) -> Path | None:
        if self.extra is not None and name == self.extra.stem:
            return self.extra
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return None
        path = self.directory / f"{name}.jsonl"
        return path if path.is_file() and is_main_tape(path) else None

    def summaries(self, now: float | None = None) -> list[TapeSummary]:
        now = time.time() if now is None else now
        paths = sorted(self.directory.glob("*.jsonl")) if self.directory.is_dir() else []
        sidecars: dict[str, list[dict[str, Any]]] = {}
        for path in paths:
            if SIDECAR_MARK in path.stem:
                with contextlib.suppress(OSError):
                    owner = path.stem.split(SIDECAR_MARK)[0]
                    sidecars.setdefault(owner, []).append({"name": path.name, "size": path.stat().st_size})
        if self.extra is not None:
            paths.append(self.extra)
            sidecars[self.extra.stem] = [{"name": p.name, "size": p.stat().st_size} for p in sidecars_of(self.extra)]
        result = []
        seen: set[Path] = set()
        for path in paths:
            if not is_main_tape(path):
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            seen.add(path)
            key = (st.st_mtime_ns, st.st_size)
            cached = self._cache.get(path)
            if cached is None or cached[0] != key:
                try:
                    cached = (key, _scan(path, st.st_size))
                except OSError:
                    continue
                self._cache[path] = cached
            scan = cached[1]
            status = tape_status(scan["open"], now - st.st_mtime)
            result.append(
                {
                    "name": path.stem,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "status": status,
                    "prompt": scan["prompt"],
                    "last": scan["last"],
                    "sidecars": sidecars.get(path.stem, []),
                    # Only tapes in the tape directory can be deleted, not one given on the command line from elsewhere.
                    "deletable": path is not self.extra,
                }
            )
        for gone in self._cache.keys() - seen:
            del self._cache[gone]
        return sort_summaries(result)

    def delete(self, names: list[str], force: bool = False) -> tuple[list[str], dict[str, str]]:
        """Delete tapes with all their sidecars. Running tapes are skipped unless ``force``.

        Returns the deleted file names and an error message per tape that was not deleted.
        """
        status = {t["name"]: t["status"] for t in self.summaries()}
        deleted: list[str] = []
        errors: dict[str, str] = {}
        for name in names:
            path = self.resolve(name)
            if path is None:
                errors[name] = "tape not found"
            elif path is self.extra:
                errors[name] = "not in the tape directory"
            elif status.get(name) == "running" and not force:
                errors[name] = "tape is running"
            else:
                for file in [*sidecars_of(path), path]:  # the tape itself last, so a failure leaves it listed
                    try:
                        file.unlink(missing_ok=True)
                    except OSError as exc:
                        errors[name] = f"{file.name}: {exc.strerror or exc}"
                        break
                    deleted.append(file.name)
                self._cache.pop(path, None)
        return deleted, errors
