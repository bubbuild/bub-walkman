"""Starlette app serving the tapes of a directory: static UI, tape list, JSON snapshots and SSE tail streams."""

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from watchfiles import awatch

from .tapes import TapeDirectory, TapeReader, read_all, read_spill, sidecar_path

STATIC_DIR = Path(__file__).parent / "static"
HEARTBEAT_INTERVAL = 15.0
FALLBACK_POLL = 2.0


def tape_info(path: Path) -> dict[str, Any]:
    try:
        st = path.stat()
        size, mtime = st.st_size, st.st_mtime
    except OSError:
        size, mtime = 0, 0.0
    return {"name": path.stem, "path": str(path), "size": size, "mtime": mtime}


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


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


def create_app(tapes_dir: Path, tape: Path | None = None) -> Starlette:
    """Serve the tapes in ``tapes_dir`` (plus ``tape``, which may live elsewhere). API calls pick one with ``?tape=<name>``."""
    directory = TapeDirectory(tapes_dir, tape)
    home = str(Path.home())
    shown_dir = "~" + str(tapes_dir)[len(home) :] if str(tapes_dir).startswith(home + "/") else str(tapes_dir)

    def pick(request: Request) -> Path | Response:
        name = request.query_params.get("tape")
        if not name:
            return JSONResponse({"error": "missing ?tape=<name>"}, 400)
        path = directory.resolve(name)
        return path if path is not None else JSONResponse({"error": f"tape not found: {name}"}, 404)

    # Stop events of open SSE streams; set them all on shutdown so streams end and the server exits promptly.
    streams: set[asyncio.Event] = set()

    async def index(request: Request) -> Response:
        page = STATIC_DIR / "index.html"
        if not page.is_file():
            return PlainTextResponse("web UI is not built: run `pnpm -C web build`", 500)
        return FileResponse(page, headers={"Cache-Control": "no-store"})

    async def favicon(request: Request) -> Response:
        icon = STATIC_DIR / "favicon.svg"
        if not icon.is_file():
            return PlainTextResponse("not found", 404)
        return FileResponse(icon, media_type="image/svg+xml", headers={"Cache-Control": "max-age=86400"})

    async def tapes(request: Request) -> Response:
        items = await asyncio.to_thread(directory.summaries)
        return JSONResponse({"directory": shown_dir, "tapes": items}, headers={"Cache-Control": "no-store"})

    async def delete(request: Request) -> Response:
        # Deleting files is only for the person at this machine: a loopback client, our own page (not a page from
        # another site, nor a DNS-rebound host name), and a custom header that a plain cross-site form cannot send.
        client = request.client.host if request.client else ""
        origin = request.headers.get("origin")
        host = request.headers.get("host", "")
        if (
            client not in ("127.0.0.1", "::1")
            or request.headers.get("x-walkman") != "1"
            or (origin is not None and origin.split("://", 1)[-1] != host)
            or host.rsplit(":", 1)[0].strip("[]") not in ("localhost", "127.0.0.1", "::1")
        ):
            return JSONResponse({"error": "forbidden"}, 403)
        try:
            body = await request.json()
            names = [str(n) for n in body["names"]]
        except (ValueError, KeyError, TypeError):
            return JSONResponse({"error": 'expected {"names": [...], "force": false}'}, 400)
        deleted, errors = await asyncio.to_thread(directory.delete, names, bool(body.get("force")))
        return JSONResponse({"deleted": deleted, "errors": errors}, 200 if not errors else 409)

    async def snapshot(request: Request) -> Response:
        tape = pick(request)
        if isinstance(tape, Response):
            return tape
        entries, offset = await asyncio.to_thread(read_all, tape)
        return JSONResponse({"tape": tape_info(tape), "entries": entries, "offset": offset})

    async def spill(request: Request) -> Response:
        tape = pick(request)
        if isinstance(tape, Response):
            return tape
        handle = request.path_params["handle"]
        if not handle.isalnum():
            return JSONResponse({"error": "bad handle"}, 400)
        path = sidecar_path(tape, "spill")
        if not path.is_file():
            return JSONResponse({"error": "spill sidecar not found"}, 404)
        data = await asyncio.to_thread(read_spill, path, handle)
        if not data["chunks"]:
            return JSONResponse({"error": "spill handle not found (sidecar may have been reset)"}, 404)
        return JSONResponse(data)

    async def stream(request: Request) -> Response:
        picked = pick(request)
        if isinstance(picked, Response):
            return picked
        tape = picked
        offset = int(request.query_params.get("offset") or 0)

        async def events() -> AsyncIterator[str]:
            reader = TapeReader(tape)
            try:
                st = tape.stat()
            except OSError:
                st = None
            if st is not None and 0 < offset <= st.st_size:
                reader.resume(offset, st)  # continue right after the client's snapshot
            elif offset:
                yield sse("reset", {"offset": 0})
            yield sse("hello", {"tape": tape_info(tape), "offset": reader.offset})

            stop = asyncio.Event()
            streams.add(stop)
            loop = asyncio.get_running_loop()
            last_beat = loop.time()
            try:
                async for _ in _changes(tape, stop):
                    if await request.is_disconnected():
                        break
                    reset, entries = await asyncio.to_thread(reader.poll)
                    if reset:
                        yield sse("reset", {"offset": 0})
                    if entries:
                        yield sse("entries", {"entries": entries, "offset": reader.offset})
                        last_beat = loop.time()
                    elif loop.time() - last_beat > HEARTBEAT_INTERVAL:
                        yield ": beat\n\n"
                        last_beat = loop.time()
            finally:
                stop.set()
                streams.discard(stop)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    app = Starlette(
        routes=[
            Route("/", index),
            Route("/favicon.svg", favicon),
            Route("/api/tapes", tapes),
            Route("/api/tapes/delete", delete, methods=["POST"]),
            Route("/api/tape", snapshot),
            Route("/api/stream", stream),
            Route("/api/spill/{handle}", spill),
            Mount("/assets", StaticFiles(directory=STATIC_DIR / "assets", check_dir=False), name="assets"),
        ]
    )
    def close_streams() -> None:
        for stop in list(streams):
            stop.set()

    app.state.close_streams = close_streams
    return app
