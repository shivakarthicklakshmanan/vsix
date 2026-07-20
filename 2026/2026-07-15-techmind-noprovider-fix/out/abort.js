"use strict";
/**
 * abort.ts
 * A cancellation primitive that works on old extension hosts.
 *
 * `AbortController` only became a Node global in 15.0.0 (backported to 14.17.0).
 * VS Code 1.61 ships Electron 13 / Node 14.16.0, where it does not exist — using
 * the global directly there throws ReferenceError the moment Stop is pressed.
 *
 * We only need `aborted`, `abort()`, and add/removeEventListener("abort"), so we
 * use the native implementation when present and fall back to a minimal shim
 * otherwise. The native AbortController satisfies this interface structurally,
 * so callers never need to know which one they got.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAbortController = createAbortController;
class ShimSignal {
    constructor() {
        this.aborted = false;
        this.listeners = [];
    }
    addEventListener(_type, listener, options) {
        // Match the native contract: adding a listener after abort still fires it.
        if (this.aborted) {
            listener();
            return;
        }
        this.listeners.push({ fn: listener, once: !!(options && options.once) });
    }
    removeEventListener(_type, listener) {
        this.listeners = this.listeners.filter((l) => l.fn !== listener);
    }
    /** @internal */
    fire() {
        if (this.aborted)
            return;
        this.aborted = true;
        const current = this.listeners;
        this.listeners = current.filter((l) => !l.once);
        for (const l of current) {
            try {
                l.fn();
            }
            catch {
                // A misbehaving listener must not prevent the others from running.
            }
        }
    }
}
class ShimController {
    constructor() {
        this.signal = new ShimSignal();
    }
    abort() {
        this.signal.fire();
    }
}
/** Native AbortController where available, otherwise an equivalent shim. */
function createAbortController() {
    const g = globalThis;
    if (typeof g.AbortController === "function") {
        return new g.AbortController();
    }
    return new ShimController();
}
//# sourceMappingURL=abort.js.map