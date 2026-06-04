'use strict';
const { encode }       = require('gpt-tokenizer');
const { getHistory, saveHistory } = require('./firebase');

// ─── Token counter ────────────────────────────────────────────────────────────
function countTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    try   { return encode(text).length; }
    catch { return Math.ceil(text.length / 4); }
}

// ─── Constants ────────────────────────────────────────────────────────────────

// In-memory cache: userId → workspace object
const userWorkspaces = new Map();

// ─── Get workspace (in-memory only, call ensureLoaded before use) ─────────────
function getWorkspace(userId) {
    if (!userWorkspaces.has(userId)) {
        userWorkspaces.set(userId, {
            history:      [],
            createdAt:    new Date().toISOString(),
            messageCount: 0,
            persona:      null,
            loaded:       false,   // not yet fetched from Firebase
            processing:   false,   // lock for concurrent requests
        });
    }
    return userWorkspaces.get(userId);
}

// ─── Ensure Firebase data is loaded into memory (idempotent) ──────────────────
async function ensureLoaded(userId) {
    const ws = getWorkspace(userId);
    if (ws.loaded) return ws;

    const saved = await getHistory(userId);
    if (saved) {
        ws.history = (saved.history || []);
        ws.persona      = saved.persona;
        ws.messageCount = saved.messageCount;
        ws.createdAt    = saved.createdAt;
        console.log(`[Workspace] Loaded ${ws.history.length} messages for user ${userId}`);
    }
    ws.loaded = true;
    return ws;
}

// ─── Compact history based on message count ────────────────────────────────────
function compactHistory(userId) {
    const ws = userWorkspaces.get(userId);
    if (!ws || !ws.history) return;

    // Filter out tool messages
    const systemMessages = ws.history.filter(m => m.role === 'system');
    const userAssistantMessages = ws.history.filter(m => m.role === 'user' || m.role === 'assistant');

    // Identify unique messages by index to preserve order and avoid reference issues
    const firstUserIndex = 0;
    const latestStartIndex = Math.max(0, userAssistantMessages.length - 20);

    const preservedIndices = new Set([firstUserIndex, ...Array.from({length: 20}, (_, i) => latestStartIndex + i)]);
    
    const preserved = userAssistantMessages.filter((_, index) => preservedIndices.has(index));

    // Reconstruct history preserving original system messages and order
    const newHistory = [...systemMessages, ...preserved];
    
    ws.history = newHistory;
}

// ─── Push message, compact, persist to Firebase ───────────────────────────────
async function pushMessage(userId, role, content) {
    const ws = await ensureLoaded(userId);
    const tokens = countTokens(content);
    ws.history.push({ role, content, tokens });
    ws.messageCount++;
    compactHistory(userId);
    await saveHistory(userId, ws);
}

// ─── Get total token count ────────────────────────────────────────────────────
function getTotalTokens(userId) {
    const ws = userWorkspaces.get(userId);
    if (!ws) return 0;
    return ws.history.reduce((s, m) => s + (m.tokens || 0), 0);
}

// ─── Wipe in-memory workspace ─────────────────────────────────────────────────
function clearWorkspace(userId) {
    userWorkspaces.delete(userId);
}

module.exports = {
    getWorkspace,
    ensureLoaded,
    pushMessage,
    compactHistory,
    getTotalTokens,
    clearWorkspace,
    userWorkspaces,
};
