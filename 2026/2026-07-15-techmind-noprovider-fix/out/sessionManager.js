"use strict";
/**
 * sessionManager.ts
 * Local, persistent chat-session store — the backing model for the "Sessions"
 * sidebar view. Sessions survive VS Code restarts because they are kept in the
 * extension's globalState (Memento), persisted to a small SQLite db on the
 * machine where VS Code runs. No network, no external storage.
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
exports.SessionManager = exports.MAX_MESSAGES_PER_SESSION = exports.MAX_SESSIONS = void 0;
const vscode = __importStar(require("vscode"));
const INDEX_KEY = "techmind.sessions.index";
const ACTIVE_KEY = "techmind.sessions.activeId";
const MSG_PREFIX = "techmind.session.";
// ── Housekeeping caps ──
exports.MAX_SESSIONS = 50; // oldest sessions pruned beyond this
exports.MAX_MESSAGES_PER_SESSION = 400; // ~200 turns; oldest trimmed beyond this
class SessionManager {
    constructor(state) {
        this.state = state;
    }
    readIndex() {
        return this.state.get(INDEX_KEY, []);
    }
    async writeIndex(list) {
        await this.state.update(INDEX_KEY, list);
    }
    /** All sessions, newest-updated first. */
    list() {
        return [...this.readIndex()].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    getActiveId() {
        let id = this.state.get(ACTIVE_KEY, "");
        const idx = this.readIndex();
        if (!id || !idx.find((s) => s.id === id)) {
            const sorted = this.list();
            id = sorted.length ? sorted[0].id : "";
        }
        return id;
    }
    async setActive(id) {
        await this.state.update(ACTIVE_KEY, id);
    }
    /** Guarantees there is an active session, creating a first one if needed. */
    async ensureActive() {
        let id = this.getActiveId();
        if (!id) {
            const meta = await this.create();
            id = meta.id;
        }
        return id;
    }
    async create(title) {
        const now = Date.now();
        const meta = {
            id: `s_${now}_${Math.random().toString(36).slice(2, 8)}`,
            title: title || "New Session",
            createdAt: now,
            updatedAt: now,
            messageCount: 0,
        };
        const idx = this.readIndex();
        idx.push(meta);
        await this.writeIndex(idx);
        await this.state.update(MSG_PREFIX + meta.id, []);
        await this.setActive(meta.id);
        await this.pruneSessions();
        return meta;
    }
    getMessages(id) {
        if (!id)
            return [];
        return this.state.get(MSG_PREFIX + id, []);
    }
    async saveMessages(id, messages) {
        if (!id)
            return;
        // Trim to cap (keep most recent)
        let msgs = messages;
        if (msgs.length > exports.MAX_MESSAGES_PER_SESSION) {
            msgs = msgs.slice(msgs.length - exports.MAX_MESSAGES_PER_SESSION);
        }
        await this.state.update(MSG_PREFIX + id, msgs);
        const idx = this.readIndex();
        const meta = idx.find((s) => s.id === id);
        if (meta) {
            meta.updatedAt = Date.now();
            meta.messageCount = msgs.length;
            // Auto-title from the first user message while still on the default title
            if ((!meta.title || meta.title === "New Session") && msgs.length) {
                const firstUser = msgs.find((m) => m.role === "user" && typeof m.content === "string");
                if (firstUser) {
                    const t = String(firstUser.content).replace(/\s+/g, " ").trim().slice(0, 40);
                    if (t)
                        meta.title = t;
                }
            }
            await this.writeIndex(idx);
        }
    }
    async rename(id, title) {
        const idx = this.readIndex();
        const meta = idx.find((s) => s.id === id);
        if (meta) {
            meta.title = title;
            await this.writeIndex(idx);
        }
    }
    async delete(id) {
        const idx = this.readIndex().filter((s) => s.id !== id);
        await this.writeIndex(idx);
        await this.state.update(MSG_PREFIX + id, undefined);
        if (this.state.get(ACTIVE_KEY, "") === id) {
            const sorted = [...idx].sort((a, b) => b.updatedAt - a.updatedAt);
            await this.setActive(sorted.length ? sorted[0].id : "");
        }
    }
    async clearAll() {
        for (const s of this.readIndex()) {
            await this.state.update(MSG_PREFIX + s.id, undefined);
        }
        await this.writeIndex([]);
        await this.setActive("");
    }
    /** Drop oldest sessions beyond MAX_SESSIONS. */
    async pruneSessions() {
        const idx = this.readIndex();
        if (idx.length <= exports.MAX_SESSIONS)
            return;
        const sorted = [...idx].sort((a, b) => b.updatedAt - a.updatedAt);
        const keep = sorted.slice(0, exports.MAX_SESSIONS);
        const drop = sorted.slice(exports.MAX_SESSIONS);
        for (const s of drop) {
            await this.state.update(MSG_PREFIX + s.id, undefined);
        }
        await this.writeIndex(keep);
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=sessionManager.js.map
