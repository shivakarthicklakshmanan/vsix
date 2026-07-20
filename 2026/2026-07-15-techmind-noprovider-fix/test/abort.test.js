/**
 * abort.test.js
 * Verifies the cancellation shim used on old extension hosts.
 *
 * VS Code 1.61 runs Electron 13 / Node 14.16, where `AbortController` is not a
 * global (it landed in Node 15.0.0, backported to 14.17.0). These tests hide the
 * global to force the shim path, so the Stop button is proven on the runtime we
 * actually target rather than only on modern Node.
 *
 * Run: node test/abort.test.js
 */

const assert = require("assert");
const path = require("path");

const OUT = path.join(__dirname, "..", "out");

/** Runs fn with globalThis.AbortController removed, then restores it. */
function withoutNativeAbort(fn) {
  const saved = globalThis.AbortController;
  delete globalThis.AbortController;
  // Drop the cached module so createAbortController re-evaluates the global.
  delete require.cache[require.resolve(path.join(OUT, "abort.js"))];
  try {
    return fn(require(path.join(OUT, "abort.js")));
  } finally {
    if (saved !== undefined) globalThis.AbortController = saved;
    delete require.cache[require.resolve(path.join(OUT, "abort.js"))];
  }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("uses the native AbortController when one exists", () => {
  const { createAbortController } = require(path.join(OUT, "abort.js"));
  const ac = createAbortController();
  assert.ok(ac.signal instanceof globalThis.AbortSignal, "expected a native signal");
});

test("falls back to the shim when the global is missing", () => {
  withoutNativeAbort(({ createAbortController }) => {
    const ac = createAbortController();
    assert.strictEqual(ac.signal.aborted, false);
    ac.abort();
    assert.strictEqual(ac.signal.aborted, true);
  });
});

test("shim notifies listeners exactly once", () => {
  withoutNativeAbort(({ createAbortController }) => {
    const ac = createAbortController();
    let n = 0;
    ac.signal.addEventListener("abort", () => n++, { once: true });
    ac.abort();
    ac.abort(); // second abort must be a no-op
    assert.strictEqual(n, 1);
  });
});

test("shim fires a listener added after abort, like the native one", () => {
  withoutNativeAbort(({ createAbortController }) => {
    const ac = createAbortController();
    ac.abort();
    let fired = false;
    ac.signal.addEventListener("abort", () => (fired = true));
    assert.strictEqual(fired, true, "late listener should fire immediately");
  });
});

test("shim honours removeEventListener", () => {
  withoutNativeAbort(({ createAbortController }) => {
    const ac = createAbortController();
    let n = 0;
    const fn = () => n++;
    ac.signal.addEventListener("abort", fn);
    ac.signal.removeEventListener("abort", fn);
    ac.abort();
    assert.strictEqual(n, 0);
  });
});

test("a throwing listener does not stop the others", () => {
  withoutNativeAbort(({ createAbortController }) => {
    const ac = createAbortController();
    let reached = false;
    ac.signal.addEventListener("abort", () => { throw new Error("boom"); });
    ac.signal.addEventListener("abort", () => (reached = true));
    ac.abort();
    assert.strictEqual(reached, true);
  });
});

test("shim actually cancels a live request through the transport", async () => {
  // Full path: fake gateway streaming slowly, cancelled via the shim.
  const http = require("http");
  const Module = require("module");

  let PORT = 0;
  const vscodeStub = {
    workspace: {
      getConfiguration: () => ({
        get: (k) => (k === "baseUrl" ? `http://127.0.0.1:${PORT}`
                   : k === "timeoutMs" ? 5000
                   : k === "streaming" ? "auto" : undefined),
      }),
    },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") return "vscode";
    return origResolve.call(this, request, ...args);
  };
  require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let i = 0;
    const t = setInterval(() => {
      if (i++ > 50) { clearInterval(t); res.end(); return; }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`);
    }, 50);
    req.on("close", () => clearInterval(t));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;

  try {
    await withoutNativeAbort(async ({ createAbortController }) => {
      delete require.cache[require.resolve(path.join(OUT, "llmClient.js"))];
      const { callChat, LlmError } = require(path.join(OUT, "llmClient.js"));
      const ac = createAbortController();
      const p = callChat("Llama-3.3-70B", [{ role: "user", content: "hi" }], { signal: ac.signal });
      setTimeout(() => ac.abort(), 120);
      await assert.rejects(p, (e) => {
        assert.ok(e instanceof LlmError);
        assert.strictEqual(e.kind, "aborted");
        return true;
      });
    });
  } finally {
    server.close();
    delete require.cache[require.resolve(path.join(OUT, "llmClient.js"))];
  }
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); pass++; }
    catch (e) { console.log(`FAIL  ${name}\n      ${e && e.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
