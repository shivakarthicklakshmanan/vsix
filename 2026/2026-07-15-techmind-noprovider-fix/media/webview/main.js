/**
 * main.js — TechMind agent panel webview.
 *
 * Owns rendering only; all model calls happen on the extension host and arrive
 * here as streamToken/streamEnd messages. Loaded as a separate asset (not an
 * inline <script>) so the panel can run under a strict CSP with a nonce.
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const md = window.TechMindMarkdown;

  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const attachBtn = document.getElementById("attachBtn");
  const attachedBar = document.getElementById("attachedBar");
  const suggested = document.getElementById("suggested");
  const status = document.getElementById("status");
  const statusText = document.getElementById("statusText");
  const stopBtn = document.getElementById("stopBtn");

  /** The in-flight assistant turn, or null when idle. */
  let active = null;
  let lastUserText = "";
  let timerId = null;
  let startedAt = 0;

  // ---------------------------------------------------------------- helpers

  function scrollToEnd() {
    chat.scrollTop = chat.scrollHeight;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function addMessage(role, text, opts) {
    const wrap = el("div", "msg");
    wrap.appendChild(el("div", "role", role));
    const bubble = el("div", "bubble" + (opts && opts.plain ? " plain" : ""));
    if (opts && opts.plain) bubble.textContent = text;
    else bubble.innerHTML = md.render(text);
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    scrollToEnd();
    return { wrap: wrap, bubble: bubble };
  }

  /** All fenced code in a response, so Insert/Save aren't limited to Python. */
  function extractCode(text) {
    const out = [];
    const re = /```[\w+-]*[ \t]*\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1].replace(/\n$/, ""));
    return out;
  }

  function guessFilename(text) {
    const m = /```([\w+-]+)/.exec(text);
    const ext = { python: "py", py: "py", javascript: "js", typescript: "ts", sql: "sql",
                  bash: "sh", sh: "sh", json: "json", yaml: "yml", java: "java" };
    return "techmind_snippet." + (ext[(m && m[1] || "").toLowerCase()] || "txt");
  }

  function button(label, onClick) {
    const b = el("button", null, label);
    b.addEventListener("click", onClick);
    return b;
  }

  function fmtSecs(ms) {
    return (ms / 1000).toFixed(1) + "s";
  }

  // ------------------------------------------------------------ busy state

  function setBusy(on, phase) {
    sendBtn.disabled = on;
    status.classList.toggle("on", on);
    if (on) {
      startedAt = Date.now();
      statusText.textContent = phase || "Working";
      clearInterval(timerId);
      timerId = setInterval(function () {
        statusText.textContent = (phase || "Working") + " · " + fmtSecs(Date.now() - startedAt);
      }, 100);
    } else {
      clearInterval(timerId);
      timerId = null;
    }
  }

  function setPhase(phase) {
    if (status.classList.contains("on")) {
      statusText.textContent = phase + " · " + fmtSecs(Date.now() - startedAt);
    }
  }

  // ------------------------------------------------------------- send/stop

  function send() {
    const text = input.value.trim();
    if (!text || active) return;
    lastUserText = text;
    addMessage("You", text, { plain: true });
    input.value = "";
    vscode.postMessage({ type: "userMessage", text: text });
  }

  sendBtn.addEventListener("click", send);
  attachBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "openFilePicker" });
  });
  stopBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "stopGeneration" });
    setPhase("Stopping");
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Grow the textarea with its content, up to the CSS max-height.
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  });

  // ------------------------------------------------------- streaming turn

  function beginTurn(info) {
    const m = addMessage("TechMind", "", {});
    m.bubble.classList.add("cursor");
    active = {
      bubble: m.bubble,
      wrap: m.wrap,
      raw: "",
      pending: false,
      info: info || {},
    };
    setBusy(true, (info && info.icon ? info.icon + " " : "") + "Routing to " + (info && info.llm ? info.llm : "model"));
  }

  function paint() {
    if (!active) return;
    active.pending = false;
    active.bubble.innerHTML = md.render(active.raw);
    scrollToEnd();
  }

  function appendToken(delta) {
    if (!active) return;
    active.raw += delta;
    // Repaint at most once per frame — re-rendering Markdown per token is wasteful.
    if (!active.pending) {
      active.pending = true;
      requestAnimationFrame(paint);
    }
  }

  function endTurn(info) {
    if (!active) return;
    const a = active;
    active = null;

    a.raw = info.text !== undefined && info.text !== null && info.text !== "" ? info.text : a.raw;
    a.bubble.classList.remove("cursor");
    a.bubble.innerHTML = md.render(a.raw);

    // Meta line
    const bits = [];
    if (info.llmUsed) bits.push("Model: " + info.llmUsed);
    if (info.taskType) bits.push(info.taskType);
    if (info.elapsedMs !== undefined) bits.push(fmtSecs(info.elapsedMs));
    if (info.streamed === false) bits.push("buffered");
    else if (info.firstTokenMs !== undefined) bits.push("first token " + fmtSecs(info.firstTokenMs));

    const meta = el("div", "meta", bits.join(" · "));
    if (info.fellBackFrom) {
      const w = el("span", "warn",
        "  ⚠ fell back from " + info.fellBackFrom +
        (info.fallbackReason ? " (" + info.fallbackReason + ")" : ""));
      meta.appendChild(w);
    }
    a.wrap.appendChild(meta);

    // Actions
    const actions = el("div", "actions");
    actions.appendChild(button("Copy", function () {
      vscode.postMessage({ type: "copyText", text: a.raw });
    }));
    actions.appendChild(button("Retry", function () {
      vscode.postMessage({ type: "retryLast" });
    }));
    const code = extractCode(a.raw);
    if (code.length) {
      const joined = code.join("\n\n");
      actions.appendChild(button("Insert into editor", function () {
        vscode.postMessage({ type: "insertIntoEditor", code: joined });
      }));
      actions.appendChild(button("Save as file", function () {
        vscode.postMessage({
          type: "saveAsFile",
          code: joined,
          suggestedName: guessFilename(a.raw),
        });
      }));
    }
    a.wrap.appendChild(actions);

    setBusy(false);
    scrollToEnd();
  }

  // ------------------------------------------------------------- messages

  window.addEventListener("message", function (event) {
    const msg = event.data;
    switch (msg.type) {
      case "streamStart":
        beginTurn(msg);
        break;

      case "phase":
        setPhase(msg.text);
        break;

      case "streamToken":
        if (!active) beginTurn({});
        appendToken(msg.delta);
        break;

      case "streamEnd":
        endTurn(msg);
        break;

      case "cancelled":
        if (active) {
          const a = active;
          active = null;
          a.bubble.classList.remove("cursor");
          if (!a.raw.trim()) a.bubble.innerHTML = "<p><em>Stopped before any output.</em></p>";
          a.wrap.appendChild(el("div", "meta", "Stopped"));
          if (a.raw.trim()) {
            const actions = el("div", "actions");
            actions.appendChild(button("Copy", function () {
              vscode.postMessage({ type: "copyText", text: a.raw });
            }));
            actions.appendChild(button("Retry", function () {
              vscode.postMessage({ type: "retryLast" });
            }));
            a.wrap.appendChild(actions);
          }
        }
        setBusy(false);
        break;

      case "error": {
        if (active) {
          active.bubble.classList.remove("cursor");
          active = null;
        }
        const m = addMessage("TechMind", "", {});
        m.bubble.classList.add("err");
        m.bubble.textContent = msg.text;
        const actions = el("div", "actions");
        actions.appendChild(button("Retry", function () {
          vscode.postMessage({ type: "retryLast" });
        }));
        m.wrap.appendChild(actions);
        setBusy(false);
        break;
      }

      case "prefill":
        input.value = msg.text;
        input.focus();
        input.dispatchEvent(new Event("input"));
        break;

      case "suggestModel":
        suggested.textContent = msg.model ? "suggested: " + msg.model : "";
        break;

      case "filesUpdated":
        if (msg.files && msg.files.length) {
          attachedBar.textContent = "📎 " + msg.files.join(", ");
          attachedBar.style.display = "block";
        } else {
          attachedBar.style.display = "none";
        }
        break;

      case "contextCleared":
        attachedBar.style.display = "none";
        attachedBar.textContent = "";
        break;
    }
  });

  input.focus();
})();
