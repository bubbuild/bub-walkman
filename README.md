# bub-walkman

Play a [Bub](https://github.com/bubbuild/bub) tape (JSONL log) as an agent timeline in the browser, live or replayed.

## Usage

```bash
uvx bub-walkman                 # pick a tape on the page; running ones are listed first
uvx bub-walkman <tape>          # a tape name in Bub's tape directory, with or without .jsonl
uvx bub-walkman ~/.bub/tapes/<tape>.jsonl
```

When installed into Bub's environment (for example `bub install bub-walkman`), `bub-walkman` also works as a Bub plugin via `bub walkman <tape>`.

- **Tape directory**: `bub.home / "tapes"` when Bub is installed, otherwise `$BUB_HOME/tapes` (default `~/.bub/tapes`).
- **Server**: starts a local server at `http://localhost:7357` by default (or a free port if `7357` is taken) and opens the page in the browser.
- **Options**: `--host`, `--port`, `--no-open`, `--version`.

## Live and replay

- **Live** (toggle at the right of the playback bar, on by default; it reads **Stop Live** while live):
  - Follows the file over SSE as Bub writes it.
  - Disables play, step, and the progress slider while active.
  - Shows a running timer on a step that has started but not finished. Bub writes a step's messages and tool calls only when the step ends, so they show up all at once.
  - Starts over if the tape is reset (truncated or replaced).
- **Replay** (when Live is off):
  - Pauses playback at the latest entry; press play to replay the tape using the real gaps between entries.
  - Controls: play/pause, change speed (`1–100×`), skip idle time (caps gaps at `2s`), drag the track to seek, and step through steps or turns.

## Reading a tape

The page has two panes (on narrow screens, the panes take turns with a back button):

- **Left pane**: lists turns (`loop.start` … `loop.finish`), with anchors and commands between them. Each turn shows its prompt, status, step count, and duration.
- **Right pane**: shows the selected turn in full:
  - Prompt, model, token usage, and a waterfall with one bar per step.
  - Steps with assistant messages, reasoning, tool calls with their arguments and results, plans, anchors, and commands.
  - When a tool output was spilled to the `__sidecar__spill` tape, it can be loaded in full.
- **Turn selection**:
  - Follows the latest turn by default: the one being written when live, or the one at the playhead when replaying.
  - Click an older turn to stay on it; click the newest one, press **↓ Latest**, or press play to follow again.

## Anchors

- Listed in the **Anchors** picker at the top of the turn list and shown as purple ticks on the track.
- Picking an anchor selects the turn that contains it and scrolls to it.
- In replay, picking an anchor also seeks there and pauses, so playback continues from that anchor.

## Search

Press `/` or `⌘F` (`Ctrl+F`) to search the full text of every entry: messages and reasoning, tool call names and arguments, tool results, system prompts, anchors, and events.

- **Query syntax**: words separated by spaces must all match; `"double quotes"` keep a phrase together.
- **Filtering**: chips filter by entry kind and show the match count for each kind.
- **Navigation**: pick a result (click, `Enter` / `⇧Enter`, or `↑`/`↓`) to select the turn and expand the tool call that contains it, scroll to it, and highlight every match on the page.
- **Replay**: searches the whole tape, dims results the playhead has not reached yet, and seeks to a result when you pick it.

## Tape list and management

Without a tape argument, the page lists every tape in Bub's tape directory, refreshed every few seconds.

- **Groups**: tapes are grouped into **running**, **active in the last hour**, and **older**.
- **Running status**: a tape counts as running when its latest turn has started (`loop.start` / `loop.step.start`) and has not ended (`loop.finish`, or a terminal `loop.step`), and the file was written in the last 15 minutes. Walkman reads only the tail of each file, so listing is cheap.
- **Switching tapes**: while viewing a tape, the top bar reads **Tapes / <tape>**. Click **Tapes** to go back to the list (which also shows how many other tapes are running), or click the tape name to switch to another one quickly.
- **Filtering**: filter the list by prompt or name. The filter and **Select** sit right above the list.
- **Deleting tapes**:
  - Hover a tape and click the trash icon, or press **Select** to delete several at once (filter first, then *Select all shown*).
  - A tape is always deleted together with its sidecars (`<tape>__sidecar__*.jsonl`). Reset archives (`*.jsonl.*.bak`) are kept.
  - The confirmation lists every file first and warns when a tape is still running.
  - Deleting only works from the machine running walkman, and only for tapes inside the tape directory.

## Keyboard shortcuts

| Key                    | Action                           |
| ---------------------- | -------------------------------- |
| `/` or `⌘F` / `Ctrl+F` | Search                           |
| `Space`                | Play / pause                     |
| `←` / `→`              | Previous / next step             |
| `⇧←` / `⇧→`            | Previous / next turn             |
| `Home` / `End`         | Jump to the start / end (replay) |
| `J` / `K`              | Next / previous turn in the list |
| `[` / `]`              | Previous / next anchor           |
| `L`                    | Live on / off                    |

## Development

```bash
pnpm -C web install
pnpm -C web build          # builds the UI into src/bub_walkman/static
uv run bub-walkman <tape>  # serve it

# UI hot reload: run the server, then Vite (it proxies /api to :7357)
uv run bub-walkman <tape> --no-open &
pnpm -C web dev
```

### Releasing

The version comes from the git tag ([hatch-vcs](https://github.com/ofek/hatch-vcs)). Push a tag to release:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The `Release` workflow builds the UI and the package, checks that the wheel version matches the tag, publishes to PyPI with [trusted publishing](https://docs.pypi.org/trusted-publishers/), and creates a GitHub release with generated notes. Tags such as `v1.0.0rc1` are marked as pre-releases.
