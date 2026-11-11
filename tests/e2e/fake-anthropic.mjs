// A stand-in for the parts of the Anthropic API GridZero uses (agent spec §3.1), so
// tests run the real SDK without a real key.

import { createServer } from "node:http";

const GOOD_KEY = "sk-ant-test-good";

export function startFakeAnthropic({ port = 0 } = {}) {
  const script = [];
  const requests = [];
  let n = 0;

  const server = createServer((req, res) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      // SDK 1.x sends the key as a bearer token; older clients send x-api-key.
      const apiKey = req.headers["x-api-key"] || (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const json = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (req.method === "GET" && path === "/v1/models") {
        requests.push({ path, apiKey, body: null });
        if (apiKey !== GOOD_KEY) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        return json(200, {
          data: [{ id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }],
          has_more: false,
          first_id: "claude-opus-5-5",
          last_id: "claude-opus-5-5",
        });
      }

      // OpenRouter's key check (GridZero calls it when someone saves an sk-or- key).
      if (req.method === "GET" && path === "/v1/key") {
        requests.push({ path, apiKey, body: null });
        if (!apiKey.startsWith("sk-or-test-")) return json(401, { error: { code: 401, message: "No auth credentials found" } });
        return json(200, { data: { label: "test", usage: 0, limit: null } });
      }

      if (req.method === "POST" && path === "/v1/messages") {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(parts).toString());
        } catch {}
        requests.push({ path, apiKey, body });
        const turn = script.shift();
        if (!turn) return json(500, { type: "error", error: { type: "api_error", message: "no scripted turn" } });

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
        const usage = { input_tokens: 100, output_tokens: 20, ...(turn.usage ?? {}) };
        send({
          type: "message_start",
          message: { id: `msg_${++n}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } },
        });
        let index = 0;
        if (turn.text) {
          send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
          for (const word of turn.text.split(/\s+/).filter(Boolean)) send({ type: "content_block_delta", index, delta: { type: "text_delta", text: word + " " } });
          send({ type: "content_block_stop", index });
          index++;
        }
        for (const tool of turn.tools ?? []) {
          send({ type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } });
          send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
          send({ type: "content_block_stop", index });
          index++;
        }
        send({ type: "message_delta", delta: { stop_reason: turn.stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
        send({ type: "message_stop" });
        return res.end();
      }

      json(404, { type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${path}` } });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, script, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
