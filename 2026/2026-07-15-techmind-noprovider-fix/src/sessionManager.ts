/**
 * sessionManager.ts
 * Local, persistent chat-session store — the backing model for the "Sessions"
 * sidebar view. Sessions survive VS Code restarts because they are kept in the
 * extension's globalState (Memento), which is persisted to a small SQLite db on
 * the machine where VS Code runs. No network, no external storage.
 *
 * Housekeeping (globalState is loaded into memory, so we keep it bounded):
 *   - Each session's transcript is stored under its OWN key (techmind.session.<id>)
 *     instead of one giant blob.
 *   - MAX_SESSIONS oldest sessions are pruned automatically.
 *   - MAX_MESSAGES_PER_SESSION oldest messages are trimmed automatically.
 *   - Only plain-text turns are stored (attached images/PDFs are never persisted).
 */

import * as vscode from "vscode";
import { ChatMessage } from "./llmRegistry";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const INDEX_KEY = "techmind.sessions.index";
const ACTIVE_KEY = "techmind.sessions.activeId";
const MSG_PREFIX = "techmind.session.";

// ── Housekeeping caps ──
export const MAX_SESSIONS = 50;              // oldest sessions pruned beyond this
export const MAX_MESSAGES_PER_SESSION = 400; // ~200 turns; oldest trimmed beyond this

export class SessionManager {
  constructor(private state: vscode.Memento) {}

  private readIndex(): SessionMeta[] {
    return this.state.get<SessionMeta[]>(INDEX_KEY, []);
  }
  private async writeIndex(list: SessionMeta[]): Promise<void> {
    await this.state.update(INDEX_KEY, list);
  }

  /** All sessions, newest-updated first. */
  list(): SessionMeta[] {
    return [...this.readIndex()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getActiveId(): string {
    let id = this.state.get<string>(ACTIVE_KEY, "");
    const idx = this.readIndex();
    if (!id || !idx.find((s) => s.id === id)) {
      const sorted = this.list();
      id = sorted.length ? sorted[0].id : "";
    }
    return id;
  }

  async setActive(id: string): Promise<void> {
    await this.state.update(ACTIVE_KEY, id);
  }

  /** Guarantees there is an active session, creating a first one if needed. */
  async ensureActive(): Promise<string> {
    let id = this.getActiveId();
    if (!id) {
      const meta = await this.create();
      id = meta.id;
    }
    return id;
  }

  async create(title?: string): Promise<SessionMeta> {
    const now = Date.now();
    const meta: SessionMeta = {
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

  getMessages(id: string): ChatMessage[] {
    if (!id) return [];
    return this.state.get<ChatMessage[]>(MSG_PREFIX + id, []);
  }

  async saveMessages(id: string, messages: ChatMessage[]): Promise<void> {
    if (!id) return;
    // Trim to cap (keep most recent)
    let msgs = messages;
    if (msgs.length > MAX_MESSAGES_PER_SESSION) {
      msgs = msgs.slice(msgs.length - MAX_MESSAGES_PER_SESSION);
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
          if (t) meta.title = t;
        }
      }
      await this.writeIndex(idx);
    }
  }

  async rename(id: string, title: string): Promise<void> {
    const idx = this.readIndex();
    const meta = idx.find((s) => s.id === id);
    if (meta) {
      meta.title = title;
      await this.writeIndex(idx);
    }
  }

  async delete(id: string): Promise<void> {
    const idx = this.readIndex().filter((s) => s.id !== id);
    await this.writeIndex(idx);
    await this.state.update(MSG_PREFIX + id, undefined);
    if (this.state.get<string>(ACTIVE_KEY, "") === id) {
      const sorted = [...idx].sort((a, b) => b.updatedAt - a.updatedAt);
      await this.setActive(sorted.length ? sorted[0].id : "");
    }
  }

  async clearAll(): Promise<void> {
    for (const s of this.readIndex()) {
      await this.state.update(MSG_PREFIX + s.id, undefined);
    }
    await this.writeIndex([]);
    await this.setActive("");
  }

  /** Drop oldest sessions beyond MAX_SESSIONS. */
  private async pruneSessions(): Promise<void> {
    const idx = this.readIndex();
    if (idx.length <= MAX_SESSIONS) return;
    const sorted = [...idx].sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = sorted.slice(0, MAX_SESSIONS);
    const drop = sorted.slice(MAX_SESSIONS);
    for (const s of drop) {
      await this.state.update(MSG_PREFIX + s.id, undefined);
    }
    await this.writeIndex(keep);
  }
}
