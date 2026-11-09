from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from bub_walkman import __version__, cli

runner = CliRunner()


def test_version_and_missing_tape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, "tapes_dir", lambda: tmp_path)
    assert runner.invoke(cli.app, ["--version"]).output.strip() == f"bub-walkman {__version__}"
    result = runner.invoke(cli.app, ["nope"])
    assert result.exit_code == 2
    assert "tape not found" in result.output


def test_resolve_tape_by_path_or_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tape = tmp_path / "abc__123.jsonl"
    tape.write_text("")
    monkeypatch.setattr(cli, "tapes_dir", lambda: tmp_path)
    assert cli.resolve_tape(tape) == tape.resolve()
    assert cli.resolve_tape(Path("abc__123")) == tape.resolve()
    assert cli.resolve_tape(Path("abc__123.jsonl")) == tape.resolve()
    assert cli.resolve_tape(Path("missing")) is None


def test_bub_plugin_registers_walkman_command() -> None:
    pytest.importorskip("bub")
    from bub_walkman import plugin

    app = typer.Typer()
    plugin.register_cli_commands(app)
    assert [c.name for c in app.registered_commands] == ["walkman"]
