/**
 * llmClient.test.js
 * Exercises the compiled transport against a local fake vLLM gateway.
 *
 * Runs on plain node (no test framework, no network, nothing to install) so it
 * works the same on the airgapped machine:  node test/llmClient.test.js
 *
 * The `vscode` module isn't available outside the extension host, so we inject a
 * stub into require.cache before loading the compiled client. That means these
 * tests drive the REAL out/llmClient.js, not a reimplementation.
 */

const http = require("http");
const assert = require("assert");
const path = require("path");
const Module = require("module");

let PORT = 0;

// ---- stub the `vscode` module ------------------------------------------------
const vscodeStub = {
  workspace: {
    getConfiguration() {
      return {
        get(key) {
          if (key === "baseUrl") return `http://127.0.0.1:${PORT}`;
          if (key === "timeoutMs") return 5000;
          if (key === "streaming") return "auto";
          if (key === "guidedMode") return true;
          return undefined;
        },
      };
    },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return "vscode";
  return origResolve.call(this, request, ...args);
};
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const OUT = path.join(__dirname, "..", "out");
const { callChat, callLLM, LlmError, checkHealth } = require(path.join(OUT, "llmClient.js"));

// ---- fake gateway ------------------------------------------------------------
/** Each handler gets (req,res,body) and fully owns the response. */
let handler = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => handler(req, res, body));
});

function sse(res, events, { delayMs = 0 } = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let i = 0;
  const next = () => {
    if (i >= events.length) return res.end();
    res.write(events[i++]);
    setTimeout(next, delayMs);
  };
  next();
}

const chunk = (content) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;

// ---- tests -------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("streams tokens and assembles the full text", async () => {
  handler = (req, res) =>
    sse(res, [
      chunk("Hello"),
      chunk(", "),
      chunk("world"),
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

  const seen = [];
  const r = await callChat("Llama-3.3-70B", [{ role: "user", content: "hi" }], {
    onToken: (t) => seen.push(t),
  });

  assert.strictEqual(r.text, "Hello, world");
  assert.deepStrictEqual(seen, ["Hello", ", ", "world"]);
  assert.strictEqual(r.streamed, true);
  assert.strictEqual(r.finishReason, "stop");
  assert.strictEqual(r.promptTokens, 11);
  assert.ok(r.firstTokenMs !== undefined, "firstTokenMs should be recorded");
});

test("reassembles events split across TCP chunk boundaries", async () => {
  // The nastiest real-world case: a frame cut in the middle of the JSON.
  const full = chunk("alpha") + chunk("beta") + "data: [DONE]\n\n";
  const mid = Math.floor(full.length / 2);
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(full.slice(0, mid));
    setTimeout(() => {
      res.write(full.slice(mid));
      res.end();
    }, 10);
  };

  const r = await callChat("Llama-3.3-70B", [{ role: "user", content: "hi" }]);
  assert.strictEqual(r.text, "alphabeta");
});

test("handles a final event with no trailing blank line", async () => {
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(chunk("one"));
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "two" } }] })}`);
  };
  const r = await callChat("Llama-3.3-70B", [{ role: "user", content: "hi" }]);
  assert.strictEqual(r.text, "onetwo");
});

test("falls back to buffered when the gateway rejects stream:true", async () => {
  let sawStream = false;
  handler = (req, res, body) => {
    const parsed = JSON.parse(body);
    if (parsed.stream) {
      sawStream = true;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stream not supported" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "buffered ok" } }] }));
  };

  const r = await callChat("Llama-3.3-70B", [{ role: "user", content: "hi" }]);
  assert.ok(sawStream, "should have attempted streaming first");
  assert.strictEqual(r.text, "buffered ok");
  assert.strictEqual(r.streamed, false);
});

test("reports streamed:false when a proxy buffers into one JSON body", async () => {
  // Gateway ignored `stream` and answered with plain JSON — must not claim it streamed.
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "all at once" } }] }));
  };
  const r = await callChat("Llama-3.3-70B", [{ role: "user", content: "hi" }]);
  assert.strictEqual(r.text, "all at once");
  assert.strictEqual(r.streamed, false);
});

test("abort mid-stream rejects with kind 'aborted'", async () => {
  handler = (req, res) => sse(res, [chunk("a"), chunk("b"), chunk("c"), chunk("d")], { delayMs: 60 });

  const ac = new AbortController();
  const p = callChat("Llama-3.3-70B", [{ role: "user", content: "hi" }], { signal: ac.signal });
  setTimeout(() => ac.abort(), 80);

  await assert.rejects(p, (e) => {
    assert.ok(e instanceof LlmError, "should be an LlmError");
    assert.strictEqual(e.kind, "aborted");
    return true;
  });
});

test("captures the real context limit from an overflow error", async () => {
  handler = (req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "This model's maximum context length is 8192 tokens, however you requested 9000",
      })
    );
  };
  await assert.rejects(callChat("Llama-3.3-70B", [{ role: "user", content: "x" }]), (e) => {
    assert.strictEqual(e.kind, "context_overflow");
    assert.strictEqual(e.maxContextTokens, 8192);
    return true;
  });
});

test("callLLM stays non-throwing for legacy callers", async () => {
  handler = (req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end("boom");
  };
  const r = await callLLM("Llama-3.3-70B", [{ role: "user", content: "hi" }]);
  assert.strictEqual(r.text, "");
  assert.ok(r.error.length > 0, "error should be reported via the field");
});

test("checkHealth extracts max_model_len", async () => {
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ id: "Nvidia/Llama-3.3-70B-Instruct-FP8", max_model_len: 16384 }],
      })
    );
  };
  const h = await checkHealth("Llama-3.3-70B");
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.maxModelLen, 16384);
});

// ---- runner ------------------------------------------------------------------
(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;

  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (e) {
      console.log(`FAIL  ${name}\n      ${e && e.message}`);
      fail++;
    }
  }
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
