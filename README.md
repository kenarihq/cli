# @kenarihq/cli

The official kenari CLI. It switches Claude Code and Codex to the [kenari](https://kenari.id)
gateway and back. When a tool is switched, its requests route through kenari and bill your
kenari wallet. Restoring puts the tool back on its original provider.

## Install and run

Run it once without installing:

```
npx @kenarihq/cli
```

Or install it globally and use the `kenari` command:

```
npm i -g @kenarihq/cli
kenari
```

Node 18 or newer is required.

## Quick start

Point Claude Code at kenari:

```
kenari use claude
```

The first run asks for a kenari API key (`kn-...`, from https://kenari.id/keys) and stores it.
It then lets you pick a kenari model for each Claude slot (opus, sonnet, haiku).

Check what each tool points at:

```
kenari status
```

Put Claude Code back on its original provider:

```
kenari use claude default
```

## Commands

| Command | What it does |
| --- | --- |
| `kenari` | Interactive switcher. Lists installed tools and lets you pick a target. |
| `kenari use <tool>` | Switch `<tool>` to kenari. Prompts for models unless you pass flags. |
| `kenari use <tool> default` | Restore `<tool>` to the provider it used before the switch. |
| `kenari status` | Show whether each tool points at kenari or its default. |
| `kenari models` | List kenari models with input and output prices. |
| `kenari key set` | Store a kenari API key (prompted, or `--stdin` to pipe it in). |
| `kenari key show` | Print the stored key, masked. |
| `kenari key delete` | Remove the stored key. |

Tools are `claude` (Claude Code) and `codex` (Codex).

Model flags for `kenari use`:

- Claude has three slots: `--opus <model> --sonnet <model> --haiku <model>`.
- Codex has one slot: `--model <model>`.

Pass any of these to skip the interactive prompt. A model that is not in the kenari catalog is
rejected. Run `kenari models` to see valid ids.

## How switching works

A switch writes the env block in `~/.claude/settings.json` and the provider entry in
`~/.codex/config.toml`, and records the previous values first. Restore puts those previous
values back and never touches keys it does not own. If you hand-edit an owned key while a tool
is switched, restore leaves that key alone and tells you which ones it skipped. Config file
locations follow `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when those are set.

## Key storage

The API key is stored in plaintext at `~/.kenari/credentials.json`. On POSIX systems the file
is written with mode 0600 (owner read and write only). On Windows the file is protected only by
your user profile ACLs. Treat the key like a password: anyone who can read the file can spend
your wallet. Remove it any time with `kenari key delete`.

## Minimum tested versions

The versions below are the tool releases this CLI has been verified against.

| Tool | Minimum tested version | Status |
| --- | --- | --- |
| Claude Code | 2.1.206 | verified end to end (switch, tool loop through kenari, restore) |
| Codex | 0.144.1 | verified end to end (switch, text and tool loop through kenari, restore) |

**Codex wire.** Codex removed the `chat/completions` wire protocol and now requires the
OpenAI `responses` API. The kenari gateway serves `/v1/responses`, so the Codex adapter
writes `wire_api = "responses"`. A switched Codex runs against kenari for both plain
prompts and tool loops.

## Troubleshooting

**"is a symlink. Refusing to replace it with a regular file."** The CLI will not overwrite a
config file that is a symlink, because replacing it would break the link. Point the CLI at the
real file, or edit the config by hand.

**"another kenari process is running."** Only one `kenari` command can modify config at a time.
Wait for the other run to finish, then retry. If no other run exists, a stale lock in
`~/.kenari/lock` is cleared automatically after a few seconds.

**"kenari rejected the API key (HTTP 401)."** The stored key is missing, wrong, or revoked. Get
a fresh key at https://kenari.id/keys and run `kenari key set`.

## License

MIT
