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
// Imported rather than used as a global: on Node 14 (VS Code 1.61's runtime) the
// global exists but isn't declared, so this keeps the build honest across hosts.
const util_1 = require("util");
const llmRegistry_1 = require("./llmRegistry");
const llmClient_1 = require("./llmClient");
const abort_1 = require("./abort");
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
            // Scripts and styles are loaded as files now, so the webview needs
            // explicit permission to read them.
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
        });
        AgentPanel.currentPanel = new AgentPanel(panel, extensionUri, getEnabledModels);
        return AgentPanel.currentPanel;
    }
    constructor(panel, extensionUri, getEnabledModels) {
        this.disposables = [];
        this.history = [];
        this.attachedFiles = [];
        this.attachedImages = [];
        /** Last prompt as the user typed it, so Retry can re-run it verbatim. */
        this.lastUserText = "";
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
                case "stopGeneration":
                    this.stopGeneration();
                    break;
                case "retryLast":
                    await this.retryLast();
                    break;
                case "copyText":
                    await vscode.env.clipboard.writeText(msg.text ?? "");
                    break;
            }
        }, null, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
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
                "All Supported": ["txt", "py", "sql", "md", "json", "yaml", "yml", "log", "sh", "csv", "js", "ts", "java", "xml", "html", "css", "png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf"],
                "Text Files": ["txt", "py", "sql", "md", "json", "yaml", "yml", "log", "sh", "csv", "js", "ts", "java", "xml", "html", "css"],
                "Images": ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
                "PDF": ["pdf"],
            },
        });
        if (!uris || uris.length === 0)
            return;
        const TEXT_EXTS = new Set(["txt", "py", "sql", "md", "json", "yaml", "yml", "log", "sh", "csv", "js", "ts", "java", "xml", "html", "css", "env", "cfg", "ini", "toml"]);
        const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
        const MIME_MAP = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
        for (const uri of uris) {
            const fileName = path.basename(uri.fsPath);
            const ext = fileName.split(".").pop()?.toLowerCase() || "";
            try {
                const rawBytes = await vscode.workspace.fs.readFile(uri);
                if (TEXT_EXTS.has(ext)) {
                    // Plain text — inject as context string (existing behaviour)
                    const content = Buffer.from(rawBytes).toString("utf8").slice(0, 15000);
                    this.attachedFiles = this.attachedFiles.filter((f) => f.name !== fileName);
                    this.attachedFiles.push({ name: fileName, content });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as text context`);
                }
                else if (IMAGE_EXTS.has(ext)) {
                    // Image — store as base64 for multimodal message to Llama
                    const b64 = Buffer.from(rawBytes).toString("base64");
                    this.attachedImages = this.attachedImages.filter((f) => f.name !== fileName);
                    this.attachedImages.push({ name: fileName, base64: b64, mimeType: MIME_MAP[ext] || "image/png" });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as image (multimodal)`);
                }
                else if (ext === "pdf") {
                    // PDF — extract raw bytes as base64; Llama-3.3-70B can read PDFs as documents
                    const b64 = Buffer.from(rawBytes).toString("base64");
                    this.attachedImages = this.attachedImages.filter((f) => f.name !== fileName);
                    this.attachedImages.push({ name: fileName, base64: b64, mimeType: "application/pdf" });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as PDF`);
                }
                else {
                    // Unknown — try reading as text anyway
                    const content = Buffer.from(rawBytes).toString("utf8").slice(0, 15000);
                    this.attachedFiles = this.attachedFiles.filter((f) => f.name !== fileName);
                    this.attachedFiles.push({ name: fileName, content });
                    vscode.window.showInformationMessage(`TechMind: attached ${fileName} as text`);
                }
            }
            catch (e) {
                vscode.window.showWarningMessage(`TechMind: could not read ${fileName}: ${e}`);
            }
        }
        // Notify webview to update the attached bar
        const allNames = [
            ...this.attachedFiles.map((f) => f.name),
            ...this.attachedImages.map((f) => `${f.name} (${f.mimeType.split("/")[0]})`),
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
        // One generation at a time — a second send while streaming would interleave
        // tokens from two turns into the same bubble.
        if (this.abortController)
            return;
        this.lastUserText = userText;
        const guidedMode = vscode.workspace.getConfiguration("techmind").get("guidedMode");
        const route = (0, llmRegistry_1.autoRoute)(userText);
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
                parts.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${img.mimeType};base64,${img.base64}`,
                        detail: "high",
                    },
                });
            }
            userPayload = parts;
        }
        else {
            userPayload = userContent;
        }
        const messages = [
            { role: "system", content: systemMsg },
            ...this.history,
            { role: "user", content: userPayload },
        ];
        const ac = (0, abort_1.createAbortController)();
        this.abortController = ac;
        this.postToWebview({
            type: "streamStart",
            llm: route.llmName,
            icon: route.icon,
            taskType: `${route.icon} ${route.taskType}`,
        });
        try {
            const result = await (0, llmClient_1.callWithFallback)(route.llmName, messages, this.getEnabledModels(), {
                signal: ac.signal,
                onToken: (delta) => this.postToWebview({ type: "streamToken", delta }),
            });
            // Store the clean turn (without the guided-mode wrapper) as memory.
            this.history.push({ role: "user", content: userText });
            this.history.push({ role: "assistant", content: result.text });
            this.postToWebview({
                type: "streamEnd",
                text: result.text,
                llmUsed: result.llmUsed,
                taskType: `${route.icon} ${route.taskType}`,
                elapsedMs: result.elapsedMs,
                streamed: result.streamed,
                firstTokenMs: result.firstTokenMs,
                fellBackFrom: result.fellBackFrom,
                fallbackReason: result.fallbackReason,
            });
        }
        catch (e) {
            const err = e;
            if (err.kind === "aborted") {
                this.postToWebview({ type: "cancelled" });
            }
            else {
                this.postToWebview({ type: "error", text: err.message || String(e) });
            }
        }
        finally {
            if (this.abortController === ac)
                this.abortController = undefined;
        }
    }
    /** Cancels the in-flight generation. The webview keeps whatever streamed so far. */
    stopGeneration() {
        this.abortController?.abort();
    }
    /**
     * Re-runs the last prompt. The failed or unsatisfying turn is dropped from
     * history first so the retry isn't biased by the answer being replaced.
     */
    async retryLast() {
        if (!this.lastUserText || this.abortController)
            return;
        const last = this.history[this.history.length - 1];
        if (last && last.role === "assistant") {
            this.history.pop();
            const prevUser = this.history[this.history.length - 1];
            if (prevUser && prevUser.role === "user")
                this.history.pop();
        }
        await this.handleUserMessage(this.lastUserText);
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
        const encoder = new util_1.TextEncoder();
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
    /**
     * The webview shell. Markup only — styles and behaviour live in
     * media/webview/ so this file stays readable and the panel can run under a
     * strict CSP (no inline script, every asset nonce- or source-restricted).
     */
    getHtml() {
        const w = this.panel.webview;
        const asset = (name) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "webview", name));
        const nonce = getNonce();
        const csp = [
            "default-src 'none'",
            `img-src ${w.cspSource} data:`,
            `style-src ${w.cspSource}`,
            `font-src ${w.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join("; ");
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset("main.css")}">
<title>TechMind Agent</title>
</head>
<body>
  <div id="header">
    <span>TechMind Agent</span>
    <span class="sub" id="suggested"></span>
  </div>
  <div id="attachedBar"></div>
  <div id="chat"></div>
  <div id="status">
    <span id="statusText">Working</span>
    <button id="stopBtn" title="Stop generating">Stop</button>
  </div>
  <div id="inputRow">
    <button id="attachBtn" title="Attach a file">&#128206;</button>
    <textarea id="input" rows="1" placeholder="Ask a technical question, paste an error, or describe what you need&#8230;"></textarea>
    <button id="sendBtn">Send</button>
  </div>
  <script nonce="${nonce}" src="${asset("markdown.js")}"></script>
  <script nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
    }
}
exports.AgentPanel = AgentPanel;
/** Fresh per page load; the CSP only trusts scripts carrying this value. */
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++)
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}
//# sourceMappingURL=agentPanel.js.map