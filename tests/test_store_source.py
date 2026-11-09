import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from starlette.testclient import TestClient

from bub_walkman.server import create_app
from bub_walkman.sources import StoreSource


def entry(id: int, kind: str = "event", meta: dict | None = None, **payload: Any) -> dict:
    return {"id": id, "kind": kind, "payload": payload, "meta": meta or {}, "date": datetime.now(UTC).isoformat()}


class MemoryStore:
    """A minimal Bub-style TapeStore that is not file based."""

    def __init__(self) -> None:
        self.tapes: dict[str, list[dict]] = {}

    def list_tapes(self) -> list[str]:
        return sorted(self.tapes)

    def reset(self, tape: str) -> None:
        self.tapes.pop(tape, None)

    def fetch_all(self, query: Any) -> list[dict]:
        return list(self.tapes.get(query.tape, []))

    def append(self, tape: str, item: dict) -> None:
        self.tapes.setdefault(tape, []).append(item)


class AsyncMemoryStore(MemoryStore):
    async def list_tapes(self) -> list[str]:  # type: ignore[override]
        return super().list_tapes()

    async def reset(self, tape: str) -> None:  # type: ignore[override]
        super().reset(tape)

    async def fetch_all(self, query: Any) -> list[dict]:  # type: ignore[override]
        return super().fetch_all(query)


def query(tape: str, store: Any) -> Any:
    return SimpleNamespace(tape=tape, store=store)


def fill(store: MemoryStore) -> None:
    store.tapes["a__1"] = [entry(1, name="loop.start", data={"prompt": "fix it"}), entry(2, name="loop.step.start")]
    store.tapes["a__1__sidecar__spill"] = [
        entry(1, "anchor", name="spill/h1/chunk/0"),
        entry(2, "tool_result", meta={"spill_handle": "h1", "spill_chunk": 0}, results=["hello"]),
    ]
    store.tapes["b__2"] = [entry(1, name="loop.start"), entry(2, name="loop.finish")]
    store.tapes["empty__3"] = []


@pytest.mark.parametrize("cls", [MemoryStore, AsyncMemoryStore])
def test_store_endpoints(cls: type[MemoryStore]) -> None:
    store = cls()
    fill(store)
    client = TestClient(create_app(StoreSource(store, query=query)), base_url="http://localhost", client=("127.0.0.1", 1))

    listing = client.get("/api/tapes").json()
    assert listing["directory"] == f"{cls.__name__} (Bub tape store)"
    tapes = {t["name"]: t for t in listing["tapes"]}
    assert list(tapes) == ["a__1", "b__2"]  # running first; sidecars and empty tapes are not listed
    assert tapes["a__1"]["status"] == "running" and tapes["a__1"]["prompt"] == "fix it"
    assert tapes["a__1"]["size"] is None and tapes["a__1"]["entries"] == 2
    assert tapes["a__1"]["sidecars"] == [{"name": "a__1__sidecar__spill", "size": None, "entries": 2}]

    snap = client.get("/api/tape?tape=a__1").json()
    assert [e["id"] for e in snap["entries"]] == [1, 2] and snap["offset"] == 2
    assert client.get("/api/tape?tape=nope").status_code == 404
    assert client.get("/api/tape?tape=a__1__sidecar__spill").status_code == 404
    assert client.get("/api/spill/h1?tape=a__1").json()["content"] == "hello"
    assert client.get("/api/spill/h1?tape=b__2").status_code == 404

    delete = lambda names, force=False: client.post(  # noqa: E731
        "/api/tapes/delete", json={"names": names, "force": force}, headers={"X-Walkman": "1"}
    )
    res = delete(["a__1"])
    assert res.status_code == 409 and res.json()["errors"] == {"a__1": "tape is running"}
    assert delete(["a__1", "b__2"], force=True).json() == {
        "deleted": ["a__1__sidecar__spill", "a__1", "b__2"],
        "errors": {},
    }
    assert set(store.tapes) == {"empty__3"}
    assert client.get("/api/tapes").json()["tapes"] == []


def test_store_follow_appends_and_resets() -> None:
    store = MemoryStore()
    fill(store)
    source = StoreSource(store, query=query, poll=0.01)

    async def run() -> list[tuple[str, Any]]:
        stop = asyncio.Event()
        seen: list[tuple[str, Any]] = []
        steps = iter(
            [
                lambda: store.append("a__1", entry(3, "message", role="assistant", content="done")),
                lambda: store.tapes.__setitem__("a__1", [entry(1, name="loop.start")]),  # reset, then rewritten
                stop.set,
            ]
        )
        async for event in source.follow("a__1", 2, stop):
            if event is None:
                next(steps)()
            else:
                seen.append((event[0], [e["id"] for e in event[1].get("entries", [])] or event[1].get("offset")))
        return seen

    assert asyncio.run(run()) == [("hello", 2), ("entries", [3]), ("reset", 0), ("entries", [1])]


def test_store_follow_from_stale_offset_resets() -> None:
    store = MemoryStore()
    fill(store)

    async def first_events() -> list[str]:
        stop = asyncio.Event()
        names = []
        async for event in StoreSource(store, query=query, poll=0.01).follow("a__1", 9, stop):
            if event is None:
                stop.set()
            else:
                names.append(event[0])
        return names

    assert asyncio.run(first_events()) == ["reset", "hello", "entries"]
