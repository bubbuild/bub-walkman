import json
import os
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from bub_walkman.server import create_app
from bub_walkman.tapes import (
    RUNNING_WINDOW,
    TapeDirectory,
    TapeReader,
    read_spill,
    sidecar_path,
)


def line(id: int, kind: str = "event", **payload) -> str:
    return json.dumps({"id": id, "kind": kind, "payload": payload, "meta": {}, "date": "2026-11-09T00:00:00+00:00"}) + "\n"


def test_reader_waits_for_complete_lines_and_detects_truncation(tmp_path: Path) -> None:
    tape = tmp_path / "t.jsonl"
    tape.write_text(line(1) + line(2)[:10])
    reader = TapeReader(tape)
    assert [e["id"] for e in reader.poll()[1]] == [1]

    with tape.open("a") as f:
        f.write(line(2)[10:])
    assert reader.poll() == (False, [json.loads(line(2))])
    assert reader.poll() == (False, [])

    tape.write_text(line(1))  # bub tape reset rewrites the file shorter
    reset, entries = reader.poll()
    assert reset and [e["id"] for e in entries] == [1]


def test_reader_skips_garbage_lines(tmp_path: Path) -> None:
    tape = tmp_path / "t.jsonl"
    tape.write_text(line(1) + "not json\n\n" + line(2))
    assert [e["id"] for e in TapeReader(tape).poll()[1]] == [1, 2]


def write_spill(tape: Path) -> None:
    sidecar = sidecar_path(tape, "spill")
    assert sidecar.name == "abc__sidecar__spill.jsonl"
    rows = []
    for i, chunk in enumerate(["hello ", "world"]):
        rows.append(line(2 * i + 1, "anchor", name=f"spill/h1/chunk/{i}"))
        rows.append(json.dumps({"id": 2 * i + 2, "kind": "tool_result", "payload": {"results": [chunk]},
                                "meta": {"spill_handle": "h1", "spill_chunk": i}, "date": ""}) + "\n")
    sidecar.write_text("".join(rows))


def test_read_spill_joins_chunks(tmp_path: Path) -> None:
    tape = tmp_path / "abc.jsonl"
    write_spill(tape)
    assert read_spill(sidecar_path(tape, "spill"), "h1") == {"handle": "h1", "chunks": 2, "content": "hello world"}
    assert read_spill(sidecar_path(tape, "spill"), "nope")["chunks"] == 0


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    tape = tmp_path / "abc.jsonl"
    tape.write_text(line(1, name="loop.start") + line(2, name="loop.step.start"))
    write_spill(tape)
    return TestClient(create_app(tmp_path))


def test_snapshot_and_spill_endpoints(client: TestClient) -> None:
    data = client.get("/api/tape?tape=abc").json()
    assert data["tape"]["name"] == "abc"
    assert [e["id"] for e in data["entries"]] == [1, 2]
    assert data["offset"] == data["tape"]["size"]

    assert client.get("/api/spill/h1?tape=abc").json()["content"] == "hello world"
    assert client.get("/api/spill/missing?tape=abc").status_code == 404
    assert client.get("/api/spill/..%2Fx?tape=abc").status_code in (400, 404)


def test_tape_selection_is_confined_to_the_directory(client: TestClient) -> None:
    assert client.get("/api/tape").status_code == 400
    for name in ["nope", "../abc", "abc__sidecar__spill", ".hidden"]:
        assert client.get("/api/tape", params={"tape": name}).status_code == 404, name
    assert [t["name"] for t in client.get("/api/tapes").json()["tapes"]] == ["abc"]


def test_tape_directory_status(tmp_path: Path) -> None:
    now = time.time()

    def tape(name: str, age: float, *lines: str) -> None:
        path = tmp_path / f"{name}.jsonl"
        path.write_text("".join(lines))
        os.utime(path, (now - age, now - age))

    tape("open", 5, line(1, name="loop.start", data={"prompt": "do it"}), line(2, name="loop.step.start"))
    tape("stale", RUNNING_WINDOW + 5, line(1, name="loop.start"))
    tape("done", 5, line(1, name="loop.start"), line(2, name="loop.finish", data={"status": "ok"}))
    tape("old_done", 10, line(1, name="loop.start"), line(2, name="loop.step", data={"status": "ok"}))
    tape("continuing", 20, line(1, name="loop.start"), line(2, name="loop.step", data={"status": "continue"}))
    tape("ancient", 86400, line(1))
    tape("open__sidecar__spill", 1, line(1))
    outside = tmp_path / "elsewhere" / "given.jsonl"
    outside.parent.mkdir()
    outside.write_text(line(1))

    d = TapeDirectory(tmp_path, outside)
    listed = {t["name"]: t for t in d.list(now)}
    assert [t["name"] for t in d.list(now)][:2] == ["open", "continuing"]
    assert {k: v["status"] for k, v in listed.items()} == {
        "open": "running",
        "continuing": "running",
        "stale": "recent",
        "done": "recent",
        "old_done": "recent",
        "ancient": "idle",
        "given": "recent",
    }
    assert listed["open"]["prompt"] == "do it"
    wrapped = "channel=$t|chat_id=1\n" + "x" * 5000 + "\n<user_request>\nfix it\n</user_request>"
    tape("wrapped", 5, line(1, name="loop.start", data={"prompt": wrapped}))
    assert {t["name"]: t for t in d.list(now)}["wrapped"]["prompt"] == "channel=$t|chat_id=1\n<user_request>\nfix it\n</user_request>"
    assert d.resolve("given") == outside and d.resolve("open") == tmp_path / "open.jsonl"


def test_delete_removes_tape_with_sidecars_and_keeps_others(tmp_path: Path) -> None:
    now = time.time()
    files = {
        "a.jsonl": line(1, name="loop.start") + line(2, name="loop.finish"),
        "a__sidecar__spill.jsonl": line(1),
        "a__sidecar__spill__sidecar__x.jsonl": line(1),
        "ab.jsonl": line(1),  # shares a prefix with "a", must survive
        "ab__sidecar__spill.jsonl": line(1),
        "a.jsonl.20261109.bak": "archive",
        "live.jsonl": line(1, name="loop.start") + line(2, name="loop.step.start"),
    }
    for name, text in files.items():
        (tmp_path / name).write_text(text)
    os.utime(tmp_path / "a.jsonl", (now - 7200, now - 7200))

    def remaining() -> set[str]:
        return {p.name for p in tmp_path.iterdir()}

    client = TestClient(create_app(tmp_path), base_url="http://127.0.0.1:7357", client=("127.0.0.1", 50000))
    listed = {t["name"]: t for t in client.get("/api/tapes").json()["tapes"]}
    assert sorted(s["name"] for s in listed["a"]["sidecars"]) == ["a__sidecar__spill.jsonl", "a__sidecar__spill__sidecar__x.jsonl"]
    assert listed["a"]["deletable"]

    ok = {"x-walkman": "1"}
    res = client.post("/api/tapes/delete", json={"names": ["a"]}, headers=ok)
    assert res.status_code == 200
    assert sorted(res.json()["deleted"]) == ["a.jsonl", "a__sidecar__spill.jsonl", "a__sidecar__spill__sidecar__x.jsonl"]
    assert remaining() == {"ab.jsonl", "ab__sidecar__spill.jsonl", "a.jsonl.20261109.bak", "live.jsonl"}

    # a running tape needs force; unknown / path-like names are refused
    res = client.post("/api/tapes/delete", json={"names": ["live", "nope", "../ab"]}, headers=ok)
    assert res.status_code == 409
    assert res.json() == {"deleted": [], "errors": {"live": "tape is running", "nope": "tape not found", "../ab": "tape not found"}}
    res = client.post("/api/tapes/delete", json={"names": ["live"], "force": True}, headers=ok)
    assert res.json()["deleted"] == ["live.jsonl"]


def test_delete_is_refused_from_other_sites(tmp_path: Path) -> None:
    (tmp_path / "a.jsonl").write_text(line(1))
    body = {"names": ["a"]}
    local = TestClient(create_app(tmp_path), base_url="http://localhost:7357", client=("127.0.0.1", 50000))
    assert local.post("/api/tapes/delete", json=body).status_code == 403  # no custom header
    assert local.post("/api/tapes/delete", json=body, headers={"x-walkman": "1", "origin": "https://evil.example"}).status_code == 403
    rebound = TestClient(create_app(tmp_path), base_url="http://evil.example:7357", client=("127.0.0.1", 50000))
    assert rebound.post("/api/tapes/delete", json=body, headers={"x-walkman": "1"}).status_code == 403
    remote = TestClient(create_app(tmp_path), base_url="http://localhost:7357", client=("192.168.1.9", 50000))
    assert remote.post("/api/tapes/delete", json=body, headers={"x-walkman": "1"}).status_code == 403
    assert (tmp_path / "a.jsonl").exists()
    res = local.post("/api/tapes/delete", json=body, headers={"x-walkman": "1", "origin": "http://localhost:7357"})
    assert res.json()["deleted"] == ["a.jsonl"]


def test_tape_outside_the_directory_is_not_deletable(tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere" / "given.jsonl"
    outside.parent.mkdir()
    outside.write_text(line(1))
    (tmp_path / "tapes").mkdir()
    client = TestClient(create_app(tmp_path / "tapes", outside), base_url="http://localhost", client=("127.0.0.1", 1))
    assert [t["deletable"] for t in client.get("/api/tapes").json()["tapes"]] == [False]
    res = client.post("/api/tapes/delete", json={"names": ["given"]}, headers={"x-walkman": "1"})
    assert res.json()["errors"] == {"given": "not in the tape directory"}
    assert outside.exists()


def test_favicon_is_served(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import bub_walkman.server as server

    (tmp_path / "favicon.svg").write_text("<svg/>")
    monkeypatch.setattr(server, "STATIC_DIR", tmp_path)
    res = TestClient(create_app(tmp_path)).get("/favicon.svg")
    assert res.status_code == 200 and res.headers["content-type"].startswith("image/svg+xml")
