# DeepSeek Harness integration

`apply-dsh-patch.mjs` makes a stock `rea-agents` install usable from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Upstream
rea-agents 6.9.0 does not start a session there: DSH forwards MCP tool schemas to
the model API, and the API rejects the whole request when one `pattern` cannot
compile.

```
Invalid schema for function 'mcp__rea__binary_session':
"^[^\\uD800-\\uDFFF]*$" is not a "regex"
```

The pattern comes from `localPathStringSchema` in `src/domain/localPath.ts`.
Zod 4 copies the regex source into JSON Schema, and the `\uD800` escape is not a
regex the API accepts.

## What the patch changes

1. `.regex(/^[^\uD800-\uDFFF]*$/u, msg)` becomes
   `.refine((value) => /^[^\uD800-\uDFFF]*$/u.test(value), msg)` in every runtime
   script that carries it (three in 6.9.0). Zod emits no `pattern` for a refine;
   the lone-surrogate check still runs and still rejects.
2. The matching `{"pattern":"^[^\\uD800-\\uDFFF]*$"}` entries are removed from
   `dist/mcp-catalog.json` and `dist/mcp-catalog-full.json`. Those files are the
   bytes `tools/list` serves, so editing the source alone changes nothing.
3. The two catalog digests in `dist/recordedMcpCatalog.js` and `dist/mcp/main.js`
   are recomputed. The server compares them at startup and exits with
   "REA could not start" when they disagree.

The NUL pattern (`^[^\x00]*$`) and the Windows absolute-path pattern stay: they
use hex escapes the API compiles.

## Install

```sh
npm install --prefix ~/.dsh/tools/rea-dsh rea-agents@6.9.0
node dsh/apply-dsh-patch.mjs ~/.dsh/tools/rea-dsh/node_modules/rea-agents
```

The script prints the patched versions, the number of sites it touched, the new
digests, and the `scripts/rea.mjs` entry to register. It is idempotent: a second
run reports zero changes and leaves matching files alone.

Verify the adapter without a client:

```sh
~/.dsh/tools/node-v24.22.1-win-x64/node.exe \
  ~/.dsh/tools/rea-dsh/node_modules/rea-agents/scripts/rea.mjs mcp doctor --json
```

`healthy: true`, 255 tools, 6 prompts.

## Register with DSH

Add a row to the profile or home patch. Node 24.22.1 matters: rea-agents declares
`engines.node = ^22.23.4 || ^24.22.1 || >=26.12.1` and exits before serving
anything on an older runtime.

```yaml
- insert:
    - id: rea-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: /absolute/path/to/node-24.22.1/node.exe
        args:
          - /absolute/path/to/rea-dsh/node_modules/rea-agents/scripts/rea.mjs
          - mcp
        env:
          REA_MCP_TOOL_CATALOG_PROFILE: hot-cold
        toolCallTimeoutMs: 450000
        startupTimeoutMs: 60000
        failOnStartupError: true
```

`hot-cold` advertises a handful of tools and loads the rest through
`discover_tools`; the full catalog is 255 tools and its schemas enter every
request. Drop the variable to advertise everything.

The bundled skill lives in the package under `skills/reverse-engineer-anything`.
DSH discovers skills in `~/.dsh/skills`, so copy it there:

```sh
cp -r ~/.dsh/tools/rea-dsh/node_modules/rea-agents/skills/reverse-engineer-anything ~/.dsh/skills/
```

## Update

`npm install` a new rea-agents version, then run the patch again. Both markers
are version-tolerant: the script rewrites whichever scripts carry the regex call
and whichever catalogs exist, and it fails with a checked message when the
pattern is gone (already fixed upstream) or a new one appears.

## Trade-off

Clients lose the machine-readable form of the lone-surrogate constraint, so a
path with a broken surrogate reaches REA and is rejected at call time instead of
being rejected by the client. Everything else about the generated schemas is
unchanged.

This patch is local to this fork. Upstream tracking:
<https://github.com/morluto/rea/issues>.
