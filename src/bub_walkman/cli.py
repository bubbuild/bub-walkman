"""bub-walkman <tape>: open a Bub tape as an agent timeline in the browser.

The same command is available as `bub walkman <tape>` when Bub is installed (see plugin.py).
"""

import os
import socket
import threading
import webbrowser
from pathlib import Path
from types import FrameType
from typing import Annotated, override
from urllib.parse import quote

import typer

from . import __version__


def tapes_dir() -> Path:
    """Bub's tape directory: ``bub.home / "tapes"`` when Bub is installed, else ``$BUB_HOME/tapes`` (default ~/.bub)."""
    try:
        import bub

        return Path(bub.home) / "tapes"
    except Exception:
        return Path(os.environ.get("BUB_HOME", "~/.bub")).expanduser() / "tapes"


def resolve_tape(tape: Path) -> Path | None:
    """A tape file path, or the name of a tape in Bub's tape directory (with or without `.jsonl`)."""
    candidates = [tape.expanduser()]
    if not tape.is_absolute() and len(tape.parts) == 1:
        directory = tapes_dir()
        candidates += [directory / tape.name, directory / f"{tape.name}.jsonl"]
    return next((c.resolve() for c in candidates if c.is_file()), None)


def _bind(host: str, port: int) -> socket.socket:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    for candidate in (port, 0):
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, candidate))
            return sock
        except OSError:
            sock.close()
            if candidate == 0:
                raise
    raise AssertionError("unreachable")


def _version(value: bool) -> None:
    if value:
        typer.echo(f"bub-walkman {__version__}")
        raise typer.Exit()


def walkman(
    tape: Annotated[
        Path | None,
        typer.Argument(
            help="Tape .jsonl file, or the name of a tape in Bub's tape directory. Without one, the page lists the tapes "
            "(running ones first) to pick from.",
            show_default=False,
        ),
    ] = None,
    host: Annotated[str, typer.Option(help="Bind address.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port; falls back to a free one when taken.")] = 7357,
    open_browser: Annotated[bool, typer.Option("--open/--no-open", help="Open the page in a browser.")] = True,
    version: Annotated[
        bool | None, typer.Option("--version", callback=_version, is_eager=True, help="Show the version and exit.")
    ] = None,
) -> None:
    """Render a Bub tape as an agent timeline in the browser. Live following and replay are controlled from the web page."""
    import uvicorn

    from .server import create_app

    directory = tapes_dir()
    path = None
    if tape is not None:
        path = resolve_tape(tape)
        if path is None:
            typer.echo(f"bub-walkman: tape not found: {tape} (also looked in {directory})", err=True)
            raise typer.Exit(2)

    sock = _bind(host, port)
    bound = sock.getsockname()[1]
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0", "::") else host
    url = f"http://{shown}:{bound}/" + (f"?tape={quote(path.stem)}" if path else "")
    typer.echo(f"bub-walkman  {path.name if path else directory}\n  {url}\n  Ctrl+C to stop")

    app = create_app(directory, path)

    class Server(uvicorn.Server):
        @override
        def handle_exit(self, sig: int, frame: FrameType | None) -> None:
            # End open live streams first; otherwise graceful shutdown waits on them until it times out.
            app.state.close_streams()
            super().handle_exit(sig, frame)

    server = Server(uvicorn.Config(app, log_level="warning", timeout_graceful_shutdown=2))
    if open_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        pass


app = typer.Typer(add_completion=False, context_settings={"help_option_names": ["-h", "--help"]})
app.command()(walkman)


def main() -> None:
    app(prog_name="bub-walkman")


if __name__ == "__main__":
    main()
