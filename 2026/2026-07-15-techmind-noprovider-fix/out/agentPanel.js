"use strict";
/**
 * agentPanel.ts
 * The right-hand "Agent" webview panel: chat UI, multi-turn memory,
 * file/selection context attachment, guided clarifying-question mode,
 * and insert-into-editor / save-as-file actions.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const llmRegistry_1 = require("./llmRegistry");
/** Flatten a message content (string or multimodal parts) to plain text for display. */
function contentToText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n");
    }
    return "";
}
class AgentPanel {
    static createOrShow(extensionUri, getEnabledModels) {
        const column = vscode.ViewColumn.Two;
        if (AgentPanel.currentPanel) {
            AgentPanel.currentPanel.panel.reveal(column);
            return AgentPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel("techmindAgent", "TechMind Agent", column, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        AgentPanel.currentPanel = new AgentPanel(panel, extensionUri, getEnabledModels);
        return AgentPanel.currentPanel;
    }
    constructor(panel, extensionUri, getEnabledModels) {
        this.disposables = [];
        this.history = [];
        this.sessionId = "";
        this.attachedFiles = [];
        this.attachedImages = []; // { name, base64, mimeType }
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.getEnabledModels = getEnabledModels;
        this.panel.webview.html = this.getHtml();
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "userMessage":
                    await this.handleUserMessage(msg.text);
                    break;
                case "insertIntoEditor":
                    await this.insertIntoActiveEditor(msg.code);
                    break;
                case "saveAsFile":
                    await this.saveAsFile(msg.code, msg.suggestedName);
                    break;
                case "clearContext":
                    this.attachedFiles = [];
                    this.attachedImages = [];
                    this.postToWebview({ type: "contextCleared" });
                    break;
                case "clearHistory":
                    this.history = [];
                    break;
                case "openFilePicker":
                    await this.attachFileFromPicker();
                    break;
            }
        }, null, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        // Load the active session's history into the panel.
        void this.loadActiveSession();
    }
    /** Load the active session's stored history into this panel and render it. */
    async loadActiveSession() {
        const sm = AgentPanel.sessionManager;
        if (!sm)
            return;
        this.sessionId = await sm.ensureActive();
        this.history = sm.getMessages(this.sessionId);
        this.attachedFiles = [];
        this.attachedImages = [];
        this.postToWebview({ type: "contextCleared" });
        this.postToWebview({
            type: "loadHistory",
            messages: this.history.map((m) => ({ role: m.role, content: contentToText(m.content) })),
        });
    }
    /** Persist the current history back to the active session (with housekeeping). */
    async persistActiveSession() {
        const sm = AgentPanel.sessionManager;
        if (!sm || !this.sessionId)
            return;
        await sm.saveMessages(this.sessionId, this.history);
        if (AgentPanel.refreshSessions)
            AgentPanel.refreshSessions();
    }
    attachFile(name, content) {
        // Replace if already attached
        this.attachedFiles = this.attachedFiles.filter((f) => f.name !== name);
        this.attachedFiles.push({ name, content: content.slice(0, 12000) });
        this.postToWebview({
            type: "filesUpdated",
            files: this.attachedFiles.map((f) => f.name),
        });
    }
    async attachFileFromPicker() {
        // Show file picker — supports text, images, PDF, common data files
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach to TechMind",
            filters: {
                "All Supported": ["txt","py","sql","md","json","yaml","yml","log","sh","csv","js","ts","java","xml","html","css","png","jpg","jpeg","gif","webp","bmp","pdf"],
                "Text Files": ["txt","py","sql","md","json","yaml","yml","log","sh","csv","js","ts","java","xml","html","css"],
                "Images": ["png","jpg","jpeg","gif","webp","bmp"],
                "PDF": ["pdf"],
            },
        });
        if (!uris || uris.length === 0) return;

        const TEXT_EXTS = new Set(["txt","py","sql","md","json","yaml","yml","log","sh","csv","js","ts","java","xml","html","css","env","cfg","ini","toml"]);
        const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","bmp"]);
        const MIME_MAP = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", webp:"image/webp", bmp:"image/bmp" };

        for (const uri of uris) {
            const fileName = path.basename(uri.fsPath);
            const ext = fileName.split(".").pop()?.toLowerCase() || "";

            try {
                const rawBytes = await vscode.workspace.fs.readFile(uri);

                if (TEXT_EXTS.has(ext)) {
                    // Plain text — inject as context string (existing behaviour)
                    const content = Buffer.from(rawBytes).toString("utf8").slice(0, 15000);
                    this.attachedFiles = this.attachedFiles.filter(f => f.name !== fileName);
                    this.attachedFiles.push({ name: fileName, content });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as text context`);

                } else if (IMAGE_EXTS.has(ext)) {
                    // Image — store as base64 for multimodal message to Llama
                    const b64 = Buffer.from(rawBytes).toString("base64");
                    this.attachedImages = this.attachedImages.filter(f => f.name !== fileName);
                    this.attachedImages.push({ name: fileName, base64: b64, mimeType: MIME_MAP[ext] || "image/png" });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as image (multimodal)`);

                } else if (ext === "pdf") {
                    // PDF — extract raw bytes as base64; Llama-3.3-70B can read PDFs as documents
                    const b64 = Buffer.from(rawBytes).toString("base64");
                    this.attachedImages = this.attachedImages.filter(f => f.name !== fileName);
                    this.attachedImages.push({ name: fileName, base64: b64, mimeType: "application/pdf" });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as PDF`);

                } else {
                    // Unknown — try reading as text anyway
                    const content = Buffer.from(rawBytes).toString("utf8").slice(0, 15000);
                    this.attachedFiles = this.attachedFiles.filter(f => f.name !== fileName);
                    this.attachedFiles.push({ name: fileName, content });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as text`);
                }
            } catch (e) {
                vscode.window.showWarningMessage(`TechMind: could not read ${fileName}: ${e}`);
            }
        }

        // Notify webview to update the attached bar
        const allNames = [
            ...this.attachedFiles.map(f => f.name),
            ...this.attachedImages.map(f => `${f.name} (${f.mimeType.split("/")[0]})`),
        ];
        this.postToWebview({ type: "filesUpdated", files: allNames });
    }
    sendSelectionAsPrompt(text, fileName) {
        this.attachFile(`${fileName} (selection)`, text);
        this.postToWebview({
            type: "prefill",
            text: `Regarding this selection from ${fileName}:\n\n`,
        });
    }
    prefillStarter(starter, preferredLlm) {
        this.postToWebview({ type: "prefill", text: starter });
        this.postToWebview({ type: "suggestModel", model: preferredLlm });
    }
    postToWebview(message) {
        this.panel.webview.postMessage(message);
    }
    buildFileContext() {
        if (this.attachedFiles.length === 0)
            return "";
        const parts = ["## ATTACHED CONTEXT (from VS Code editor)\n"];
        for (const f of this.attachedFiles) {
            parts.push(`### ${f.name}\n\`\`\`\n${f.content}\n\`\`\`\n`);
        }
        return parts.join("\n");
    }
    async handleUserMessage(userText) {
        const guidedMode = vscode.workspace.getConfiguration("techmind").get("guidedMode");
        const route = (0, llmRegistry_1.autoRoute)(userText);
        this.postToWebview({ type: "routing", llm: route.llmName, taskType: route.taskType, icon: route.icon });
        let systemMsg = llmRegistry_1.SYSTEM_CONTEXT;
        const fileCtx = this.buildFileContext();
        if (fileCtx)
            systemMsg += `\n\n${fileCtx}`;
        let userContent = userText;
        if (guidedMode && userText.split(/\s+/).length > 20) {
            userContent =
                "Before providing the full solution, identify if there is ONE critical clarifying question " +
                    "needed to produce the best answer. If yes, ask it briefly and stop there. If the request is " +
                    "clear enough to proceed, say 'Proceeding:' and then give the full answer.\n\n" +
                    `User request:\n${userText}`;
        }
        // Build user content — plain string if no images, multimodal array if images/PDFs attached
        let userPayload;
        if (this.attachedImages.length > 0) {
            // Multimodal: content is an array of parts
            const parts = [];
            // Add text part first
            parts.push({ type: "text", text: userContent });
            // Add each image/PDF as base64
            for (const img of this.attachedImages) {
                if (img.mimeType === "application/pdf") {
                    // Llama handles PDFs as a document block (vLLM OpenAI-compat)
                    parts.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${img.mimeType};base64,${img.base64}`,
                            detail: "high",
                        },
                    });
                } else {
                    // Standard image_url block for images
                    parts.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${img.mimeType};base64,${img.base64}`,
                            detail: "high",
                        },
                    });
                }
            }
            userPayload = parts;
        } else {
            userPayload = userContent;
        }
        const messages = [
            { role: "system", content: systemMsg },
            ...this.history,
            { role: "user", content: userPayload },
        ];
        const result = await (0, llmRegistry_1.callWithFallback)(route.llmName, messages, this.getEnabledModels());
        if (!result.text) {
            this.postToWebview({ type: "error", text: `All models failed. ${result.error}` });
            return;
        }
        // Store clean turn (without guided-mode wrapper) for memory
        this.history.push({ role: "user", content: userText });
        this.history.push({ role: "assistant", content: result.text });
        void this.persistActiveSession();
        this.postToWebview({
            type: "assistantMessage",
            text: result.text,
            llmUsed: result.llmUsed,
            taskType: `${route.icon} ${route.taskType}`,
            elapsedMs: result.elapsedMs,
            note: result.error || "",
        });
    }
    async insertIntoActiveEditor(code) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("No active editor to insert into.");
            return;
        }
        await editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, code);
        });
        vscode.window.showInformationMessage("Inserted into editor.");
    }
    async saveAsFile(code, suggestedName) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const defaultUri = workspaceFolders
            ? vscode.Uri.joinPath(workspaceFolders[0].uri, suggestedName)
            : vscode.Uri.file(suggestedName);
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { "Python": ["py"], "All Files": ["*"] },
        });
        if (!uri)
            return;
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(code));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`Saved: ${path.basename(uri.fsPath)}`);
    }
    dispose() {
        AgentPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d)
                d.dispose();
        }
    }
    getHtml() {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  #header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-weight: 600;
    font-size: 13px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  #header .sub { font-weight: 400; opacity: 0.7; font-size: 11px; }
  #attachedBar {
    padding: 6px 14px;
    font-size: 11px;
    opacity: 0.8;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: none;
  }
  #chat {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
  }
  .msg { margin-bottom: 16px; }
  .role { font-size: 11px; opacity: 0.6; margin-bottom: 3px; }
  .bubble {
    white-space: pre-wrap;
    line-height: 1.45;
    font-size: 13px;
  }
  .bubble code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
  }
  .bubble pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }
  .meta { font-size: 10px; opacity: 0.55; margin-top: 4px; }
  .actions { margin-top: 6px; display: flex; gap: 6px; }
  .actions button {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #routingBanner {
    font-size: 11px;
    opacity: 0.7;
    padding: 4px 14px;
    display: none;
  }
  #inputBar {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 10px;
    display: flex;
    gap: 6px;
  }
  #userInput {
    flex: 1;
    resize: none;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    min-height: 36px;
    max-height: 140px;
  }
  #sendBtn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 0 16px;
    cursor: pointer;
    font-size: 13px;
  }
  #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
  .error { color: var(--vscode-errorForeground); }
  #attachBtn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    padding: 0 10px;
    cursor: pointer;
    font-size: 16px;
  }
  #attachBtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <div id="header">
    <span>TechMind Agent</span>
    <span class="sub" id="modelSuggestion"></span>
  </div>
  <div id="attachedBar"></div>
  <div id="routingBanner"></div>
  <div id="chat"></div>
  <div id="inputBar">
    <button id="attachBtn" title="Attach file (text, image, PDF)">📎</button>
    <textarea id="userInput" placeholder="Ask a technical question, paste an error, or describe what you need..."></textarea>
    <button id="sendBtn">Send</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById('chat');
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const attachedBar = document.getElementById('attachedBar');
  const routingBanner = document.getElementById('routingBanner');
  const modelSuggestion = document.getElementById('modelSuggestion');

  let msgCounter = 0;

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdownish(text) {
    // Minimal: turn \`\`\`lang\\ncode\`\`\` into <pre><code>, leave rest as escaped text
    const parts = text.split(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 3 === 0) {
        html += escapeHtml(parts[i]);
      } else if (i % 3 === 2) {
        html += "<pre><code>" + escapeHtml(parts[i]) + "</code></pre>";
      }
    }
    return html || escapeHtml(text);
  }

  function extractCodeBlocks(text) {
    const re = /\`\`\`(?:python|py)?\\n([\\s\\S]*?)\`\`\`/g;
    const blocks = [];
    let m;
    while ((m = re.exec(text)) !== null) blocks.push(m[1]);
    return blocks;
  }

  function addMessage(role, text, meta) {
    const id = 'msg_' + (msgCounter++);
    const div = document.createElement('div');
    div.className = 'msg';
    const roleLabel = role === 'user' ? 'You' : 'TechMind';
    let html = '<div class="role">' + roleLabel + '</div>';
    html += '<div class="bubble">' + renderMarkdownish(text) + '</div>';
    if (meta) html += '<div class="meta">' + meta + '</div>';
    div.innerHTML = html;

    if (role === 'assistant') {
      const blocks = extractCodeBlocks(text);
      if (blocks.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        const insertBtn = document.createElement('button');
        insertBtn.textContent = '↪ Insert into editor';
        insertBtn.onclick = () => vscode.postMessage({ type: 'insertIntoEditor', code: blocks.join('\\n\\n') });
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '💾 Save as .py';
        saveBtn.onclick = () => vscode.postMessage({ type: 'saveAsFile', code: blocks.join('\\n\\n'), suggestedName: 'techmind_output.py' });
        actions.appendChild(insertBtn);
        actions.appendChild(saveBtn);
        div.appendChild(actions);
      }
    }

    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    addMessage('user', text);
    input.value = '';
    routingBanner.style.display = 'block';
    routingBanner.textContent = 'Routing...';
    vscode.postMessage({ type: 'userMessage', text });
  }

  const attachBtn = document.getElementById('attachBtn');
  attachBtn.onclick = () => vscode.postMessage({ type: 'openFilePicker' });

  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'routing':
        routingBanner.style.display = 'block';
        routingBanner.textContent = msg.icon + ' Routing to ' + msg.llm + ' (' + msg.taskType + ')...';
        break;
      case 'assistantMessage': {
        routingBanner.style.display = 'none';
        let meta = 'Model: ' + msg.llmUsed + ' · ' + msg.taskType + ' · ' + (msg.elapsedMs/1000).toFixed(1) + 's';
        if (msg.note) meta += ' · ' + msg.note;
        addMessage('assistant', msg.text, meta);
        break;
      }
      case 'error':
        routingBanner.style.display = 'none';
        addMessage('assistant', '❌ ' + msg.text, null);
        break;
      case 'prefill':
        input.value = msg.text;
        input.focus();
        break;
      case 'suggestModel':
        modelSuggestion.textContent = 'suggested: ' + msg.model;
        break;
      case 'filesUpdated':
        attachedBar.style.display = 'block';
        attachedBar.textContent = '📎 Attached: ' + msg.files.join(', ');
        break;
      case 'contextCleared':
        attachedBar.style.display = 'none';
        attachedBar.textContent = '';
        break;
      case 'loadHistory':
        chat.innerHTML = '';
        msgCounter = 0;
        routingBanner.style.display = 'none';
        (msg.messages || []).forEach(function (m) {
          addMessage(m.role === 'user' ? 'user' : 'assistant', m.content, null);
        });
        break;
    }
  });
</script>
</body>
</html>`;
    }
}
exports.AgentPanel = AgentPanel;
//# sourceMappingURL=agentPanel.js.map