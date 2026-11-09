"""Starlette app serving tapes: static UI, tape list, JSON snapshots and SSE tail streams."""

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

from .sources import FileSource, TapeSource

STATIC_DIR = Path(__file__).parent / "static"
HEARTBEAT_INTERVAL = 15.0


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def create_app(source: TapeSource | Path, tape: Path | None = None) -> Starlette:
    """Serve the tapes of ``source``: a tape store, or a tape directory (plus ``tape``, which may live elsewhere).

    API calls pick one tape with ``?tape=<name>``.
    """
    if isinstance(source, Path):
        source = FileSource(source, tape)
    tapes_source = source

    async def pick(request: Request) -> tuple[str, dict[str, Any]] | Response:
        name = request.query_params.get("tape")
        if not name:
            return JSONResponse({"error": "missing ?tape=<name>"}, 400)
        info = await tapes_source.info(name)
        return (name, info) if info is not None else JSONResponse({"error": f"tape not found: {name}"}, 404)

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
        items = await tapes_source.summaries()
        return JSONResponse({"directory": tapes_source.label, "tapes": items}, headers={"Cache-Control": "no-store"})

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
        deleted, errors = await tapes_source.delete(names, bool(body.get("force")))
        return JSONResponse({"deleted": deleted, "errors": errors}, 200 if not errors else 409)

    async def snapshot(request: Request) -> Response:
        picked = await pick(request)
        if isinstance(picked, Response):
            return picked
        name, info = picked
        entries, offset = await tapes_source.snapshot(name)
        return JSONResponse({"tape": info, "entries": entries, "offset": offset})

    async def spill(request: Request) -> Response:
        picked = await pick(request)
        if isinstance(picked, Response):
            return picked
        handle = request.path_params["handle"]
        if not handle.isalnum():
            return JSONResponse({"error": "bad handle"}, 400)
        data = await tapes_source.spill(picked[0], handle)
        if isinstance(data, str):
            return JSONResponse({"error": data}, 404)
        if not data["chunks"]:
            return JSONResponse({"error": "spill handle not found (sidecar may have been reset)"}, 404)
        return JSONResponse(data)

    async def stream(request: Request) -> Response:
        picked = await pick(request)
        if isinstance(picked, Response):
            return picked
        name = picked[0]
        offset = int(request.query_params.get("offset") or 0)

        async def events() -> AsyncIterator[str]:
            stop = asyncio.Event()
            streams.add(stop)
            loop = asyncio.get_running_loop()
            last_beat = loop.time()
            try:
                async for event in tapes_source.follow(name, offset, stop):
                    if event is not None:
                        yield sse(*event)
                        last_beat = loop.time()
                    elif await request.is_disconnected():
                        break
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
        lifespan=lambda app: tapes_source.lifespan(),
        routes=[
            Route("/", index),
            Route("/favicon.svg", favicon),
            Route("/api/tapes", tapes),
            Route("/api/tapes/delete", delete, methods=["POST"]),
            Route("/api/tape", snapshot),
            Route("/api/stream", stream),
            Route("/api/spill/{handle}", spill),
            Mount("/assets", StaticFiles(directory=STATIC_DIR / "assets", check_dir=False), name="assets"),
        ],
    )

    def close_streams() -> None:
        for stop in list(streams):
            stop.set()

    app.state.close_streams = close_streams
    return app
