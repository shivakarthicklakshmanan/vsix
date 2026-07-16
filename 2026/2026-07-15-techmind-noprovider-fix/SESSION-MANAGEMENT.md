# Session Management — Change & Reproduction Guide

Hand-writing reference for adding **persistent chat sessions** to TechMind Studio
in an offline / airgapped environment. Everything below is scoped to this fix
folder only (the root project is intentionally untouched for now).

Sessions are stored locally in VS Code's `globalState` (Memento) — persisted to a
small SQLite db (`state.vscdb`) on the machine where VS Code runs. No network, no
external storage.

---

## 1. Folder structure (after the change)

`+` = new file, `~` = modified file, (unmarked) = unchanged.

```
2026-07-15-techmind-noprovider-fix/
├── package.json                ~  view + commands + menus added
├── tsconfig.json
├── .vscodeignore
├── make_vsix.py                   Python packager (used to build the .vsix)
├── make-vsix.js
├── build.js
├── README.md                      (the earlier "no data provider" fix notes)
├── SESSION-MANAGEMENT.md       +  this guide
├── techmind-studio-1.0.0.vsix  ~  rebuilt to include session management
├── media/
│   └── icon.svg
├── src/                           TypeScript sources
│   ├── sessionManager.ts       +  NEW — the session store (Memento + housekeeping)
│   ├── sidebarProviders.ts     ~  added SessionsProvider + SessionItem
│   ├── extension.ts            ~  register view, wire manager, 4 commands
│   ├── agentPanel.ts           ~  load/save history per session, loadHistory render
│   ├── llmRegistry.ts             unchanged
│   └── workflows.ts               unchanged
└── out/                           Compiled JS shipped inside the .vsix
    ├── sessionManager.js       +  NEW — compiled from sessionManager.ts
    ├── sidebarProviders.js     ~
    ├── extension.js            ~
    ├── agentPanel.js           ~
    ├── llmRegistry.js             unchanged
    └── workflows.js               unchanged
```

> Every `src/*.ts` has a matching `out/*.js`. In airgapped setups without Node you
> can hand-write both; with Node you only write the `.ts` and run `tsc`.

---

## 2. New files

### `src/sessionManager.ts`  (+ `out/sessionManager.js`)
The whole session model. Public API used by the rest of the extension:

| Method | Purpose |
|--------|---------|
| `new SessionManager(context.globalState)` | construct over a `vscode.Memento` |
| `list(): SessionMeta[]` | all sessions, newest-updated first |
| `getActiveId(): string` | current active session id (`""` if none) |
| `setActive(id)` | mark a session active |
| `ensureActive(): Promise<string>` | return active id, creating a first session if needed |
| `create(title?): Promise<SessionMeta>` | make + activate a new session |
| `getMessages(id): ChatMessage[]` | stored transcript for a session |
| `saveMessages(id, messages)` | persist transcript (trims + auto-titles + touches `updatedAt`) |
| `rename(id, title)` / `delete(id)` / `clearAll()` | management |

**Storage keys (Memento):**

```
techmind.sessions.index      -> SessionMeta[]   (metadata only)
techmind.sessions.activeId   -> string
techmind.session.<id>        -> ChatMessage[]   (one key PER session)
```

**`SessionMeta` shape:**

```ts
interface SessionMeta {
  id: string;          // "s_<epoch>_<rand>"
  title: string;       // defaults "New Session", auto-set from 1st user msg
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
```

**Housekeeping constants (top of the file — tune as needed):**

```ts
export const MAX_SESSIONS = 50;              // oldest sessions pruned beyond this
export const MAX_MESSAGES_PER_SESSION = 400; // ~200 turns; oldest trimmed beyond this
```

Rules: transcripts live under one key **per session** (not a single blob); on save,
messages beyond the cap are trimmed (keep most recent); on create, sessions beyond
the cap are pruned (oldest by `updatedAt`); only **plain-text** turns are stored —
attached images/PDFs are never persisted.

---

## 3. Changed files — exactly what to add

### 3a. `package.json`  (contributions)

**Add a `techmind.sessions` view as the FIRST entry** under
`contributes.views["techmind-sidebar"]`:

```json
{ "id": "techmind.sessions", "name": "Sessions", "icon": "media/icon.svg" },
```

**Add 4 commands** at the top of `contributes.commands`:

```json
{ "command": "techmind.newSession",    "title": "TechMind: New Session",    "icon": "$(add)"   },
{ "command": "techmind.switchSession", "title": "TechMind: Open Session" },
{ "command": "techmind.renameSession", "title": "TechMind: Rename Session", "icon": "$(edit)"  },
{ "command": "techmind.deleteSession", "title": "TechMind: Delete Session", "icon": "$(trash)" },
```

**Add menus** — a `+` button on the Sessions title bar, and inline rename/delete on
each item (inside `contributes.menus`):

```json
"view/title": [
  { "command": "techmind.checkEndpoints", "when": "view == techmind.models",   "group": "navigation" },
  { "command": "techmind.newSession",     "when": "view == techmind.sessions", "group": "navigation" }
],
"view/item/context": [
  { "command": "techmind.renameSession", "when": "view == techmind.sessions && viewItem == sessionItem", "group": "inline" },
  { "command": "techmind.deleteSession", "when": "view == techmind.sessions && viewItem == sessionItem", "group": "inline" }
]
```

> (`activationEvents` already contains `"onStartupFinished"` from the earlier fix —
> keep it; it is what makes the providers register.)

### 3b. `src/sidebarProviders.ts`

- Import the model: `import { SessionManager, SessionMeta } from "./sessionManager";`
- Add a `relTime(ts)` helper ("just now / Nm ago / Nh ago / Nd ago").
- Add **`SessionItem extends vscode.TreeItem`** — label = title, `description` shows
  `● <n> msg · <relTime>` (● only when active), `contextValue = "sessionItem"`,
  and `command = techmind.switchSession` with `arguments: [meta.id]`.
- Add **`SessionsProvider implements vscode.TreeDataProvider<SessionItem>`** with an
  `EventEmitter` + `refresh()`, whose `getChildren()` maps `sessions.list()` to items
  and marks the one equal to `sessions.getActiveId()`.

### 3c. `src/extension.ts`

- Imports: add `SessionsProvider, SessionItem` to the `./sidebarProviders` import and
  `import { SessionManager } from "./sessionManager";`
- Near the top of `activate()`:

```ts
const sessionManager   = new SessionManager(context.globalState);
const sessionsProvider = new SessionsProvider(sessionManager);
AgentPanel.sessionManager = sessionManager;
AgentPanel.refreshSessions = () => sessionsProvider.refresh();
```

- Register the view (add as the first `registerTreeDataProvider` in the existing push):

```ts
vscode.window.registerTreeDataProvider("techmind.sessions", sessionsProvider),
```

- Ensure a session exists on startup:

```ts
sessionManager.ensureActive().then(() => sessionsProvider.refresh());
```

- Add 4 commands (full bodies are in the file): `techmind.newSession`,
  `techmind.switchSession(sessionId)`, `techmind.renameSession(item)`,
  `techmind.deleteSession(item)`. New/switch call
  `AgentPanel.createOrShow(...).loadActiveSession()`; rename/delete use
  `showInputBox` / modal `showWarningMessage` then `sessionsProvider.refresh()`.

### 3d. `src/agentPanel.ts`

- Import: `import { SessionManager } from "./sessionManager";`
- Add a module-level helper `contentToText(content)` that flattens a string OR a
  multimodal parts-array to plain text (for rendering restored history).
- Add static wiring fields + a per-instance id:

```ts
public static sessionManager: SessionManager | undefined;
public static refreshSessions: (() => void) | undefined;
private sessionId: string = "";
```

- At the **end of the constructor**: `void this.loadActiveSession();`
- Add two methods:
  - `loadActiveSession()` — `ensureActive()`, load `getMessages()`, clear attachments,
    post `{ type: "contextCleared" }` then `{ type: "loadHistory", messages: [...] }`.
  - `persistActiveSession()` — `saveMessages(sessionId, history)` then
    `AgentPanel.refreshSessions?.()`.
- In `handleUserMessage()`, right after pushing the user + assistant turns to
  `this.history`, call `void this.persistActiveSession();`
- In the **webview `<script>`** message switch, add a `loadHistory` case that clears
  `#chat`, resets the counter, and re-renders each stored message via `addMessage`.

**Webview message protocol (extension → webview) added:**

```
{ type: "loadHistory", messages: [ { role, content } ] }
```

---

## 4. Build (offline)

From inside this folder:

```
python make_vsix.py          # -> techmind-studio-1.0.0.vsix (no Node needed)
```

`make_vsix.py` zips everything in `out/` + `media/` + `package.json` into the vsix.
Because `out/sessionManager.js` now exists, it is included automatically.

With a Node runtime you can instead recompile first:

```
node <path-to>/typescript/lib/tsc.js -p ./
python make_vsix.py
```

Install: VS Code → Extensions → … → **Install from VSIX…** → `techmind-studio-1.0.0.vsix`

---

## 5. Behaviour to verify after install

1. **Sessions** panel appears at the top of the TechMind sidebar.
2. **＋** creates a new session; sending a message auto-titles it from the first line.
3. Clicking another session loads its transcript into the Agent panel.
4. Rename / Delete (inline icons) work; deleting the active one falls back to another.
5. Restart VS Code → sessions and their history are still there.
6. Attach an image/PDF and send — it reaches the model but is **not** saved in history.
