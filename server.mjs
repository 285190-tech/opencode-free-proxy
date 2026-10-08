import express from "express";
import crypto from "crypto";
import https from "https";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── CORS ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.SERVER_PORT || process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.18.31";
const PROXY_VERSION = "11";

// ── Upstream endpoints ─────────────────────────────────────────────
const ZEN_HOST = "opencode.ai";
const ZEN_PATH = "/zen/v1/chat/completions";
const PUAI_HOST = "puai-proxy.davidzk.tech";
const PUAI_PATH = "/opencode/v1/chat/completions";

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (tok === key) return name;
  }
  return null;
}

// ── ID generation (matches ProjectUAI registry.lua) ────────────────
//   session:  ses_ + 12 lowercase hex + 14 Base62 = 30 chars
//   request:  req_ + 12 lowercase hex + 14 Base62 = 30 chars
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(len) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += BASE62[bytes[i] % 62];
  return out;
}
function randomHex(len) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}
function ocId(prefix) {
  return `${prefix}${randomHex(12)}${randomBase62(14)}`;
}

// ── Models ─────────────────────────────────────────────────────────
const MODELS = [
  "big-pickle",
  "jev-1.13-free",
  "exo-free",
  "mimo-v2.6-flash-free",
  "nemotron-3-ultra-free",
  "ling-3.1-flash-free",
];

// ── Standard OpenCode tool definitions (required by free tier) ─────
const OPENCODE_TOOLS = [
  { type: "function", function: { name: "bash", description: "Execute bash command",
    parameters: { type: "object", properties: { command: { type: "string", description: "The command to run" } }, required: ["command"] } } },
  { type: "function", function: { name: "read", description: "Read file",
    parameters: { type: "object", properties: { path: { type: "string", description: "The path to the file" } }, required: ["path"] } } },
  { type: "function", function: { name: "edit", description: "Edit file",
    parameters: { type: "object", properties: { path: { type: "string", description: "The path to the file" } }, required: ["path"] } } },
  { type: "function", function: { name: "glob", description: "Find files",
    parameters: { type: "object", properties: { pattern: { type: "string", description: "Glob pattern" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep", description: "Search pattern",
    parameters: { type: "object", properties: { pattern: { type: "string", description: "Regex pattern" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "list", description: "List files",
    parameters: { type: "object", properties: { path: { type: "string", description: "Directory path" } } } } },
];

// ── Session tracking (per user, rotate every 30 min) ───────────────
const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: ocId("ses_"), ts: now };
  }
  return userSessions[user].id;
}

// ── Build request body (ProjectUAI-compatible) ─────────────────────
function buildBody(model, messages, stream, tools, tool_choice) {
  // Zen free tier: force stream and stream_options
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Merge standard OpenCode tools with any caller-supplied ones
  const toolNames = new Set();
  const merged = [];
  for (const t of tools || []) {
    const name = t.function?.name || t.name;
    if (name) toolNames.add(name);
    merged.push(t);
  }
  for (const t of OPENCODE_TOOLS) {
    if (!toolNames.has(t.function.name)) merged.push(t);
  }
  body.tools = merged;
  body.tool_choice = tool_choice || "auto";

  return body;
}

// ── Build headers (ProjectUAI registry.lua opencodeHeaders) ────────
function buildHeaders(body, sessionId, host) {
  return {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Authorization": "Bearer public",
    "User-Agent": `opencode/${OC_VERSION}`,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-request": ocId("req_"),
    "x-opencode-session": sessionId,
    "Accept": "text/event-stream",
  };
}

// ── Detect "unauthorized client" refusal (ProjectUAI proxy.lua) ────
function isClientRefusal(statusCode, bodyText) {
  if (statusCode !== 400 && statusCode !== 401 && statusCode !== 403 && statusCode !== 200) {
    return false;
  }
  if (bodyText.length > 65536) return false;

  const lower = bodyText.toLowerCase();

  // Credential / account errors do NOT qualify for recovery
  if (lower.includes("invalid api key") || lower.includes("incorrect api key") ||
      lower.includes("expired api key") || lower.includes("api key is invalid") ||
      lower.includes("api key expired") || lower.includes("invalid key") ||
      lower.includes("freetiererror") || lower.includes("insufficient permissions")) {
    return false;
  }

  // Structured error field
  let decoded;
  try { decoded = JSON.parse(bodyText); } catch { decoded = null; }

  const normalize = (s) => String(s).toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
  const clientRefusal = (s) => {
    if (typeof s !== "string") return false;
    const t = normalize(s);
    return t.includes("unauthorized client") ||
           t.includes("unauthorizedclient") ||
           t.includes("client is not authorized") ||
           t.includes("client is not authorised");
  };

  if (decoded && typeof decoded === "object") {
    const err = decoded.error;
    if (typeof err === "string") return clientRefusal(err);
    if (err && typeof err === "object") {
      return clientRefusal(err.type) || clientRefusal(err.code) ||
             clientRefusal(err.message) || clientRefusal(err.name) || clientRefusal(err.detail);
    }
    if (statusCode === 200 && decoded.type !== "error") return false;
    return clientRefusal(decoded.type) || clientRefusal(decoded.code) ||
           clientRefusal(decoded.message) || clientRefusal(decoded.name) || clientRefusal(decoded.detail);
  }

  // Plain text refusal
  return statusCode !== 200 && bodyText.length <= 512 &&
         !bodyText.includes("<") && !bodyText.includes("data:") &&
         clientRefusal(bodyText);
}

// ── https.request wrapper returning a Promise ──────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Main request with proxy fallback ───────────────────────────────
async function zenRequestWithFallback(model, messages, tools, tool_choice, sessionId) {
  const bodyObj = buildBody(model, messages, true, tools, tool_choice);
  const body = JSON.stringify(bodyObj);

  // Attempt 1: direct to opencode.ai
  const directOptions = {
    hostname: ZEN_HOST,
    port: 443,
    path: ZEN_PATH,
    method: "POST",
    headers: buildHeaders(body, sessionId, ZEN_HOST),
    timeout: 120000,
  };

  let res = await httpsRequest(directOptions, body);

  // Inspect for client refusal
  const bodyText = res.body.toString("utf8");
  if (isClientRefusal(res.statusCode, bodyText)) {
    console.log("[ZEN] Unauthorized client — switching to ProjectUAI proxy");

    const proxyBody = JSON.stringify(bodyObj);
    const proxyOptions = {
      hostname: PUAI_HOST,
      port: 443,
      path: PUAI_PATH,
      method: "POST",
      headers: {
        ...buildHeaders(proxyBody, sessionId, PUAI_HOST),
        "Content-Length": Buffer.byteLength(proxyBody),
      },
      timeout: 120000,
    };

    res = await httpsRequest(proxyOptions, proxyBody);
  }

  return res;
}

// ── Anthropic conversion (unchanged) ───────────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id, type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }
  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
  }));
  return { messages, tools: tools.length ? tools : undefined };
}

function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return { id: ocId("msg_"), type: "message", role: "assistant",
      content: [{ type: "text", text: "" }], model, stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  }
  const content = [];
  if (choice.message?.content) content.push({ type: "text", text: choice.message.content });
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({ type: "tool_use", id: tc.id || ocId("msg_"), name: tc.function.name, input });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  return {
    id: ocId("msg_"), type: "message", role: "assistant", content, model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    },
  };
}

// ── OpenAI passthrough ─────────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({ object: "list", data: MODELS.map(id => ({ id, object: "model", created: 1779000000, owned_by: "opencode-free" })) });
});

app.post("/v1/chat/completions", async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }

  const sessionId = getSession(user);
  console.log("[OAI]", new Date().toISOString(), user, model, "session:", sessionId.slice(0, 20) + "...");

  try {
    const zenRes = await zenRequestWithFallback(model, messages, tools, tool_choice, sessionId);
    const bodyText = zenRes.body.toString("utf8");

    // If caller asked for JSON (stream=false), return the whole thing
    if (!stream) {
      // Zen forces stream anyway, so we have to assemble. But since our proxy
      // forces stream:true upstream, just return the raw SSE with a JSON wrapper
      // OR parse the SSE into a single reply. Simpler: return the raw response
      // but tell the caller it's SSE. If they truly want JSON, parse it.
      if (bodyText.startsWith("data:") || bodyText.includes("\ndata:")) {
        // Parse SSE into an OpenAI-style reply
        const lines = bodyText.split("\n");
        let content = "";
        let finishReason = "stop";
        let usage = null;
        let responseId = null;
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            if (j.id) responseId = j.id;
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) content += delta;
            const fr = j.choices?.[0]?.finish_reason;
            if (fr) finishReason = fr;
            if (j.usage) usage = j.usage;
          } catch {}
        }
        return res.json({
          id: responseId || ocId("msg_"),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: finishReason,
          }],
          usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      // Non-SSE: return as-is
      res.writeHead(zenRes.statusCode, { "Content-Type": "application/json" });
      return res.end(zenRes.body);
    }

    // Streaming: relay as-is
    res.writeHead(zenRes.statusCode, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.end(zenRes.body);
  } catch (e) {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
  }
});

// ── Anthropic endpoint ─────────────────────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });

  const { model } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: `Unknown model: ${model}` } });
  }

  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model);

  try {
    const zenRes = await zenRequestWithFallback(model, messages, tools, undefined, sessionId);
    const bodyText = zenRes.body.toString("utf8");

    // Parse SSE into a single reply
    const lines = bodyText.split("\n");
    let content = "";
    let finishReason = "stop";
    let usage = null;
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) content += delta;
        const fr = j.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        if (j.usage) usage = j.usage;
      } catch {}
    }

    const oaiResp = {
      choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
      usage,
    };
    res.json(openAIToAnthropic(oaiResp, model, inputTokens));
  } catch (e) {
    console.log("[ZEN ERROR]", e.message);
    res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
  }
});

// ── Health ─────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok",
  version: `v${PROXY_VERSION}`,
  models: MODELS.length,
  upstream: "opencode.ai/zen + ProjectUAI proxy fallback",
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
}));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} on http://0.0.0.0:${PORT}`);
  console.log("  Upstream:  opencode.ai/zen/v1 → fallback: puai-proxy.davidzk.tech/opencode/v1");
  console.log("  Models:", MODELS.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
});
