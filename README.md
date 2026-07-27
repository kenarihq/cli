# @kenarihq/cli

Route native and Kenari models inside one Claude Code or Codex CLI session.
Plain `claude` and `codex` stay native. Kenari routing only applies when launched
through the wrapper:

```bash
kenari claude [args...]
kenari codex [args...]
```

Each launch starts a private router on `127.0.0.1` with a random port, starts the
original CLI with process-scoped overrides, forwards terminal I/O and signals,
then stops the router. No provider setting or credential is written into Claude
Code or Codex configuration.

## Install

```bash
npm install -g @kenarihq/cli
kenari login
kenari configure
```

Node.js 18 or newer is required.

## Commands

```text
kenari configure [claude|codex]
kenari reset [claude|codex]
kenari claude [args...]
kenari codex [args...]
kenari status [--check] [--json]
kenari models [--json]
kenari login [--no-browser] [--paste] [--stdin]
kenari logout
kenari help
```

`kenari use` and `kenari key` were removed. Routing is process-scoped and
credentials are managed by `login` and `logout`.

## Routing configuration

Claude Code supports these roles:

- `main`
- `opus`
- `sonnet`
- `haiku`
- `fable`
- `subagents`

Codex supports these roles:

- `main`
- `review`
- `subagents`

Every role can stay `native` or select a fixed `kenari/<model-id>`. Codex main
also supports `picker`. Codex review and subagents also support `inherit`.
Native is always the default.

For Codex, Kenari detects whether `codex login` uses ChatGPT or an API key and
keeps native requests on the matching OpenAI upstream. The process-scoped
router disables request compression and WebSocket transport so it can inspect
the model ID before selecting the upstream.

Automation must set every role:

```bash
kenari configure claude \
  --main native \
  --opus native \
  --sonnet kenari/glm-5-2 \
  --haiku native \
  --fable native \
  --subagents native \
  --yes

kenari configure codex \
  --main picker \
  --review inherit \
  --subagents kenari/gpt-5.4 \
  --yes
```

Unprefixed model IDs always route to the native provider. `kenari/` model IDs
always route to Kenari. Routing never falls back between providers.

## Files

Kenari owns these files:

```text
~/.kenari/config.json
~/.kenari/credentials.json
~/.kenari/model-cache.json
~/.kenari/state.json
```

The directory uses mode `0700` and files use mode `0600` on POSIX systems.
Writes are atomic. The Kenari credential is stored only in
`credentials.json`, never in Claude Code settings, Codex configuration,
generated model catalogs, command arguments, or logs.

`KENARI_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` override their matching
directories. `KENARI_BASE_URL` overrides the Kenari gateway. HTTP gateways are
rejected unless `KENARI_ALLOW_HTTP=1` is set for local development.

## Catalog and offline behavior

`kenari configure` fetches and validates the model catalog. The cache is fresh
for 24 hours.

- Native-only configuration works without login or catalog access.
- A stale valid cache can be used when refresh fails.
- A required Kenari route without a valid cache or credential fails closed.
- A removed or unknown Kenari model fails closed.
- `kenari status` is offline. `kenari status --check` runs bounded network
  checks.

## Reset and logout

`kenari reset` removes routing choices without changing native tool
configuration or login state. `kenari logout` removes only the Kenari
credential. Native routes keep working after logout.

## License

MIT
