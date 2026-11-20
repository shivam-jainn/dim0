#!/usr/bin/env node
// dim0-mcp: efficient stdio MCP bridge for dim0 (self-hosted, ARM-native).
// 5 tools only. Auth via DIM0_API_TOKEN (JWT from POST /users/signin).
// Backend URL via DIM0_API_URL (default http://localhost:8081).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.DIM0_API_URL || "http://localhost:8081").replace(/\/$/, "");
const TOKEN = process.env.DIM0_API_TOKEN || "";

function headers(json = true) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
  return h;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 4000) };
  }
  if (!res.ok) {
    const msg = data?.detail || data?.message || res.statusText;
    throw new Error(`dim0 ${method} ${path} -> ${res.status}: ${msg}`);
  }
  // unwrap standard {data: ...} envelope when present
  if (data && typeof data === "object" && "data" in data && Object.keys(data).length <= 3) {
    return data.data ?? data;
  }
  return data;
}

function summarizeGraph(graph) {
  if (!graph) return null;
  const nodes = graph.nodes || [];
  const kinds = {};
  for (const n of nodes) {
    const k = n?.style?.type || n?.type || "unknown";
    kinds[k] = (kinds[k] || 0) + 1;
  }
  return {
    uid: graph.uid,
    label: graph.label,
    node_count: nodes.length,
    kinds,
    nodes: nodes.slice(0, 30).map((n) => ({
      id: n.id,
      type: n?.style?.type || n?.type,
      label: n?.label?.markdown?.slice(0, 200),
      content: n?.content?.markdown?.slice(0, 500),
      parent_id: n.parent_id,
    })),
    truncated: nodes.length > 30,
  };
}

const TOOLS = [
  {
    name: "dim0_status",
    description:
      "Check dim0 backend reachability + public model catalog. No auth needed. Use first before board tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dim0_list_boards",
    description: "List boards visible to DIM0_API_TOKEN. Requires auth token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dim0_get_board",
    description:
      "Get one board. Default returns summary (counts + first 30 nodes). Set whole=true for full graph (large). Requires auth token.",
    inputSchema: {
      type: "object",
      properties: {
        graph_id: { type: "string", description: "Board UID" },
        whole: { type: "boolean", default: false },
      },
      required: ["graph_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dim0_add_notes",
    description:
      "Add markdown notes to a board. Each item is a markdown string (or {markdown, label}). Minimal Note payloads, ids auto-generated. Requires auth token with member role.",
    inputSchema: {
      type: "object",
      properties: {
        graph_id: { type: "string" },
        notes: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  markdown: { type: "string" },
                  label: { type: "string" },
                },
                required: ["markdown"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["graph_id", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "dim0_ai_search",
    description:
      "Web search via dim0 backend. Engine 'parallel' is keyless on self-host (no auth). Others need server keys / X-Provider-Key relay (not exposed here).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        engine: {
          type: "string",
          enum: ["parallel", "perplexity", "tavily", "linkup", "exa"],
          default: "parallel",
        },
        max_results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const server = new Server({ name: "dim0-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "dim0_status": {
        const models = await api("/ai/models");
        const llm = models?.llm || models;
        const count = Array.isArray(llm) ? llm.length : Object.keys(llm || {}).length;
        return {
          content: [
            { type: "text", text: JSON.stringify({ backend: BASE, ok: true, model_catalog_entries: count, auth: TOKEN ? "token set" : "no token (board tools will 401)" }) },
          ],
        };
      }
      case "dim0_list_boards": {
        if (!TOKEN) throw new Error("DIM0_API_TOKEN not set. Sign in via frontend, POST /users/signin, export the access_token.");
        const out = await api("/boards");
        const graphs = out?.graphs || out || [];
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                (Array.isArray(graphs) ? graphs : []).map((g) => ({ id: g.uid, label: g.label, role: g.role })),
              ),
            },
          ],
        };
      }
      case "dim0_get_board": {
        if (!TOKEN) throw new Error("DIM0_API_TOKEN not set.");
        const whole = args.whole ? "?whole=true" : "";
        const out = await api(`/boards/${encodeURIComponent(args.graph_id)}${whole}`);
        const graph = out?.graph || out;
        const summary = summarizeGraph(graph);
        const payload = args.whole ? { ...out, graph: { ...graph, nodes: graph?.nodes?.slice(0, 200) }, truncated_nodes: (graph?.nodes?.length || 0) > 200 } : { ...out, graph: undefined, summary };
        return { content: [{ type: "text", text: JSON.stringify(payload).slice(0, 60000) }] };
      }
      case "dim0_add_notes": {
        if (!TOKEN) throw new Error("DIM0_API_TOKEN not set.");
        const notes = args.notes.map((n) =>
          typeof n === "string"
            ? { content: { markdown: n } }
            : { content: { markdown: n.markdown }, ...(n.label ? { label: { markdown: n.label } } : {}) }
        );
        const out = await api(`/boards/${encodeURIComponent(args.graph_id)}/notes`, {
          method: "POST",
          body: { notes },
        });
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      }
      case "dim0_ai_search": {
        const out = await api("/ai/search", {
          method: "POST",
          body: {
            query: args.query,
            engine: args.engine || "parallel",
            max_results: args.max_results || 5,
          },
        });
        const results = (out?.results || []).map((r) => ({ url: r.url, title: r.title }));
        return {
          content: [{ type: "text", text: JSON.stringify({ answer: (out?.answer || "").slice(0, 2000), results }).slice(0, 20000) }],
        };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
