"""Where tapes come from: JSONL files in a directory, or any Bub tape store (when running as a Bub plugin).

Every source speaks the same small async protocol, so the server does not care which one it serves. Offsets are
opaque to the page: a byte offset for files, an entry count for stores.
"""

import asyncio
import contextlib
import dataclasses
import inspect
import time
from collections.abc import AsyncIterator, Callable, Iterable
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from watchfiles import awatch

from .tapes import (
    SIDECAR_MARK,
    Entry,
    TapeDirectory,
    TapeReader,
    TapeSummary,
    collect_spill,
    read_all,
    read_spill,
    scan_entries,
    sidecar_path,
    sort_summaries,
    tape_status,
)

FALLBACK_POLL = 2.0
STORE_POLL = 1.0
STORE_LIST_TTL = 3.0
STORE_CONCURRENCY = 8

type Event = tuple[str, dict[str, Any]] | None
"""An SSE event for the page (``hello``, ``reset``, ``entries``), or None for "nothing new yet"."""


class TapeSource(Protocol):
    @property
    def label(self) -> str:
        """Where the tapes live, shown on the tape list (a directory, or the store's name)."""
        ...

    def lifespan(self) -> contextlib.AbstractAsyncContextManager[None]: ...

    async def summaries(self) -> list[TapeSummary]: ...

    async def info(self, name: str) -> dict[str, Any] | None:
        """``{name, path, size, mtime}`` of a tape, or None when there is no such tape."""
        ...

    async def snapshot(self, name: str) -> tuple[list[Entry], int]:
        """All entries of a tape, and the offset to follow it from."""
        ...

    def follow(self, name: str, offset: int, stop: asyncio.Event) -> AsyncIterator[Event]:
        """Events for a tape from ``offset`` on, until ``stop`` is set. Yields None now and then while idle."""
        ...

    async def spill(self, name: str, handle: str) -> dict[str, Any] | str:
        """The spilled tool output ``handle`` of a tape, or an error message."""
        ...

    async def delete(self, names: list[str], force: bool) -> tuple[list[str], dict[str, str]]: ...


# -- files ----------------------------------------------------------------------------


async def _changes(path: Path, stop: asyncio.Event) -> AsyncIterator[None]:
    """Yield whenever ``path`` may have changed: on filesystem events, or every few seconds."""
    watcher = awatch(
        path.parent,
        stop_event=stop,
        debounce=50,
        step=50,
        rust_timeout=int(FALLBACK_POLL * 1000),
        yield_on_timeout=True,
        watch_filter=lambda _, p: Path(p).name == path.name,
    )
    async for _ in watcher:
        yield None


class FileSource:
    """Tapes stored as ``<name>.jsonl`` files in Bub's tape directory (plus one tape file given from elsewhere)."""

    def __init__(self, directory: Path, extra: Path | None = None) -> None:
        self.directory = TapeDirectory(directory, extra)
        home = str(Path.home())
        text = str(directory)
        self.label = "~" + text[len(home) :] if text.startswith(home + "/") else text

    @contextlib.asynccontextmanager
    async def lifespan(self) -> AsyncIterator[None]:
        yield

    async def summaries(self) -> list[TapeSummary]:
        return await asyncio.to_thread(self.directory.summaries)

    @staticmethod
    def _info(path: Path) -> dict[str, Any]:
        try:
            st = path.stat()
            size, mtime = st.st_size, st.st_mtime
        except OSError:
            size, mtime = 0, 0.0
        return {"name": path.stem, "path": str(path), "size": size, "mtime": mtime}

    async def info(self, name: str) -> dict[str, Any] | None:
        path = self.directory.resolve(name)
        return None if path is None else self._info(path)

    async def snapshot(self, name: str) -> tuple[list[Entry], int]:
        path = self.directory.resolve(name)
        return await asyncio.to_thread(read_all, path) if path is not None else ([], 0)

    async def follow(self, name: str, offset: int, stop: asyncio.Event) -> AsyncIterator[Event]:
        path = self.directory.resolve(name)
        if path is None:
            return
        reader = TapeReader(path)
        try:
            st = path.stat()
        except OSError:
            st = None
        if st is not None and 0 < offset <= st.st_size:
            reader.resume(offset, st)  # continue right after the page's snapshot
        elif offset:
            yield "reset", {"offset": 0}
        yield "hello", {"tape": self._info(path), "offset": reader.offset}
        async for _ in _changes(path, stop):
            reset, entries = await asyncio.to_thread(reader.poll)
            if reset:
                yield "reset", {"offset": 0}
            yield ("entries", {"entries": entries, "offset": reader.offset, "size": reader.offset}) if entries else None

    async def spill(self, name: str, handle: str) -> dict[str, Any] | str:
        path = self.directory.resolve(name)
        sidecar = sidecar_path(path, "spill") if path is not None else None
        if sidecar is None or not sidecar.is_file():
            return "spill sidecar not found"
        return await asyncio.to_thread(read_spill, sidecar, handle)

    async def delete(self, names: list[str], force: bool) -> tuple[list[str], dict[str, str]]:
        return await asyncio.to_thread(self.directory.delete, names, force)


# -- Bub tape stores ------------------------------------------------------------------


def _entry(entry: Any) -> Entry:
    if isinstance(entry, dict):
        return entry
    if dataclasses.is_dataclass(entry) and not isinstance(entry, type):
        return dataclasses.asdict(entry)
    return {k: getattr(entry, k, None) for k in ("id", "kind", "payload", "meta", "date")}


def _timestamp(date: str) -> float:
    try:
        return datetime.fromisoformat(date).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _bub_query(tape: str, store: Any) -> Any:
    from bub.core.store import TapeQuery

    return TapeQuery(tape=tape, store=store)


class StoreSource:
    """Tapes in a Bub ``TapeStore`` or ``AsyncTapeStore``, whatever it persists to.

    A store has no change notifications or byte offsets, so a followed tape is re-read every second and its offset is
    the number of entries already sent. Deleting a tape resets it (and its sidecars) in the store.
    """

    def __init__(
        self,
        store: Any,
        *,
        sidecars: Iterable[str] = (),
        label: str | None = None,
        query: Callable[[str, Any], Any] = _bub_query,
        poll: float = STORE_POLL,
    ) -> None:
        self.store = store
        self.label = label or f"{type(store).__name__} (Bub tape store)"
        self.sidecar_names = sorted({"spill", *sidecars})
        self._query = query
        self._poll = poll
        self._cache: dict[str, tuple[tuple[int, Any], TapeSummary]] = {}
        self._listed: tuple[float, list[TapeSummary]] | None = None
        self._limit = asyncio.Semaphore(STORE_CONCURRENCY)

    @contextlib.asynccontextmanager
    async def lifespan(self) -> AsyncIterator[None]:
        yield

    async def _call(self, method: str, *args: Any) -> Any:
        fn = getattr(self.store, method)
        if inspect.iscoroutinefunction(fn):
            return await fn(*args)
        return await asyncio.to_thread(fn, *args)

    async def _read(self, name: str) -> list[Entry]:
        async with self._limit:
            entries = await self._call("fetch_all", self._query(name, self.store))
        return [_entry(e) for e in entries or ()]

    async def _names(self) -> list[str]:
        return [str(n) for n in await self._call("list_tapes")]

    async def _summary(self, name: str) -> TapeSummary | None:
        entries = await self._read(name)
        if not entries:
            return None  # never written, or reset: nothing to show
        key = (len(entries), entries[-1].get("id"))
        cached = self._cache.get(name)
        if cached is None or cached[0] != key:
            sidecars = []
            for sidecar in self.sidecar_names:
                tape = f"{name}{SIDECAR_MARK}{sidecar}"
                if count := len(await self._read(tape)):
                    sidecars.append({"name": tape, "size": None, "entries": count})
            scan = scan_entries(entries)
            cached = (key, {**scan, "entries": len(entries), "sidecars": sidecars})
            self._cache[name] = cached
        scan = cached[1]
        mtime = _timestamp(scan["last"])
        return {
            "name": name,
            "size": None,
            "entries": scan["entries"],
            "mtime": mtime,
            "status": tape_status(scan["open"], time.time() - mtime),
            "prompt": scan["prompt"],
            "last": scan["last"],
            "sidecars": scan["sidecars"],
            "deletable": True,
        }

    async def summaries(self) -> list[TapeSummary]:
        # Listing reads every tape; the page asks every few seconds, so share one listing between close requests.
        if self._listed is not None and time.monotonic() - self._listed[0] < STORE_LIST_TTL:
            return self._listed[1]
        mains = [n for n in await self._names() if SIDECAR_MARK not in n]
        found = await asyncio.gather(*(self._summary(n) for n in mains))
        for gone in self._cache.keys() - set(mains):
            del self._cache[gone]
        result = sort_summaries([s for s in found if s is not None])
        self._listed = (time.monotonic(), result)
        return result

    def _valid(self, name: str) -> bool:
        return bool(name) and SIDECAR_MARK not in name

    async def info(self, name: str) -> dict[str, Any] | None:
        if not self._valid(name):
            return None
        entries = await self._read(name)
        if not entries and name not in await self._names():
            return None
        return self._info(name, entries)

    def _info(self, name: str, entries: list[Entry]) -> dict[str, Any]:
        last = str(entries[-1].get("date") or "") if entries else ""
        return {"name": name, "path": f"{self.label}: {name}", "size": None, "entries": len(entries), "mtime": _timestamp(last)}

    async def snapshot(self, name: str) -> tuple[list[Entry], int]:
        entries = await self._read(name)
        return entries, len(entries)

    async def follow(self, name: str, offset: int, stop: asyncio.Event) -> AsyncIterator[Event]:
        entries = await self._read(name)
        sent = offset
        if not 0 <= offset <= len(entries):
            yield "reset", {"offset": 0}
            sent = 0
        # The id of the last entry sent tells a reset apart from a tape that only grew.
        last_id = entries[sent - 1].get("id") if sent else None
        yield "hello", {"tape": self._info(name, entries[:sent]), "offset": sent}
        while not stop.is_set():
            if len(entries) < sent or (sent and entries[sent - 1].get("id") != last_id):
                yield "reset", {"offset": 0}
                sent, last_id = 0, None
            if len(entries) > sent:
                new = entries[sent:]
                sent, last_id = len(entries), new[-1].get("id")
                yield "entries", {"entries": new, "offset": sent, "size": None}
            else:
                yield None
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), self._poll)
            if stop.is_set():
                break
            entries = await self._read(name)

    async def spill(self, name: str, handle: str) -> dict[str, Any] | str:
        entries = await self._read(f"{name}{SIDECAR_MARK}spill")
        if not entries:
            return "spill sidecar not found"
        return collect_spill(entries, handle)

    async def delete(self, names: list[str], force: bool) -> tuple[list[str], dict[str, str]]:
        self._listed = None
        status = {t["name"]: t for t in await self.summaries()}
        deleted: list[str] = []
        errors: dict[str, str] = {}
        for name in names:
            summary = status.get(name)
            if summary is None:
                errors[name] = "tape not found"
                continue
            if summary["status"] == "running" and not force:
                errors[name] = "tape is running"
                continue
            for tape in [*(s["name"] for s in summary["sidecars"]), name]:  # the tape itself last
                try:
                    await self._call("reset", tape)
                except Exception as exc:  # any store error: report it for this tape and go on
                    errors[name] = f"{tape}: {exc}"
                    break
                deleted.append(tape)
            self._cache.pop(name, None)
        self._listed = None
        return deleted, errors


# -- Bub plugin -----------------------------------------------------------------------


class BubSource:
    """The tape store of a running Bub framework, picked when the server starts.

    Bub's file store keeps using the directory directly (byte offsets, file watching); any other store is read through
    the store API.
    """

    def __init__(self, framework: Any, fallback_dir: Path, extra: Path | None = None) -> None:
        self.framework = framework
        self.fallback_dir = fallback_dir
        self.extra = extra
        self.inner: TapeSource = FileSource(fallback_dir, extra)

    @property
    def label(self) -> str:
        return self.inner.label

    @contextlib.asynccontextmanager
    async def lifespan(self) -> AsyncIterator[None]:
        async with self.framework.running():
            self.inner = pick_source(self.framework, self.fallback_dir, self.extra)
            async with self.inner.lifespan():
                yield

    async def summaries(self) -> list[TapeSummary]:
        return await self.inner.summaries()

    async def info(self, name: str) -> dict[str, Any] | None:
        return await self.inner.info(name)

    async def snapshot(self, name: str) -> tuple[list[Entry], int]:
        return await self.inner.snapshot(name)

    def follow(self, name: str, offset: int, stop: asyncio.Event) -> AsyncIterator[Event]:
        return self.inner.follow(name, offset, stop)

    async def spill(self, name: str, handle: str) -> dict[str, Any] | str:
        return await self.inner.spill(name, handle)

    async def delete(self, names: list[str], force: bool) -> tuple[list[str], dict[str, str]]:
        return await self.inner.delete(names, force)


def pick_source(framework: Any, fallback_dir: Path, extra: Path | None = None) -> TapeSource:
    """A source for the framework's tape store: files for Bub's ``FileTapeStore``, the store API for anything else."""
    from bub.core.store import FileTapeStore

    store = framework.get_tape_store()
    if store is None:
        return FileSource(fallback_dir, extra)
    if isinstance(store, FileTapeStore):
        directory = getattr(store, "_directory", None)
        return FileSource(Path(directory) if directory is not None else fallback_dir, extra)
    sidecars = [s.name for s in framework.get_tape_sidecars()]
    inner = getattr(store, "_store", store)  # name the store an AsyncTapeStoreAdapter wraps, not the adapter
    return StoreSource(store, sidecars=sidecars, label=f"{type(inner).__name__} (Bub tape store)")
