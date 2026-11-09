"""Bub plugin: adds `bub walkman <tape>` when bub-walkman is installed next to Bub.

Registered through the `bub` entry-point group; Bub only imports this module, so the `bub` import is safe.
"""

import typer
from bub import hookimpl


@hookimpl
def register_cli_commands(app: typer.Typer) -> None:
    from .cli import walkman

    app.command("walkman")(walkman)
