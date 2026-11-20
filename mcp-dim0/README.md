# dim0-mcp — efficient MCP bridge for dim0

Stdio MCP server with **5 tools** wrapping the local dim0 backend. No polling, bounded responses.

## Tools

| tool | auth | what |
|---|---|---|
| `dim0_status` | no | backend reachability + model catalog size |
| `dim0_list_boards` | `DIM0_API_TOKEN` | boards visible to token |
| `dim0_get_board` | `DIM0_API_TOKEN` | summary by default (counts + 30 nodes); `whole=true` for up to 200 nodes |
| `dim0_add_notes` | `DIM0_API_TOKEN` | max 20 markdown notes per call, ids auto-generated |
| `dim0_ai_search` | no (`parallel` keyless on self-host) | web search via backend |

## Env

- `DIM0_API_URL` (default `http://localhost:8081`)
- `DIM0_API_TOKEN` (JWT access token from `POST /users/signin`; board tools 401 without it)

## Run

```sh
cd mcp-dim0 && npm install --omit=dev
DIM0_API_URL=http://localhost:8081 node server.mjs
```

opencode wiring lives in the repo-root `opencode.json` (`dim0` server entry).
