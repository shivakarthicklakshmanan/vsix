"use strict";
/**
 * config.ts
 * Central accessors for TechMind settings. Kept separate from llmRegistry so the
 * transport layer (llmClient) can read configuration without importing the
 * registry's routing logic, and vice versa — no circular imports.
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
exports.getBaseUrl = getBaseUrl;
exports.getTimeout = getTimeout;
exports.getGuidedMode = getGuidedMode;
exports.getStreamingMode = getStreamingMode;
const vscode = __importStar(require("vscode"));
const DEFAULT_BASE_URL = "https://chatbotapi.analytics.idb.gunk.in";
const DEFAULT_TIMEOUT_MS = 120000;
function cfg() {
    return vscode.workspace.getConfiguration("techmind");
}
function getBaseUrl() {
    return cfg().get("baseUrl") || DEFAULT_BASE_URL;
}
function getTimeout() {
    return cfg().get("timeoutMs") || DEFAULT_TIMEOUT_MS;
}
function getGuidedMode() {
    return cfg().get("guidedMode") ?? true;
}
function getStreamingMode() {
    const v = cfg().get("streaming");
    return v === "on" || v === "off" ? v : "auto";
}
//# sourceMappingURL=config.js.map