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
const HISTORY_TOKEN_LIMIT = 3000;
const GLOBAL_TOKEN_LIMIT  = 10000;

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
        ws.history = (saved.history || []).map(m => ({
            ...m,
            tokens: m.tokens ?? countTokens(m.content),
        }));
        ws.persona      = saved.persona;
        ws.messageCount = saved.messageCount;
        ws.createdAt    = saved.createdAt;
        console.log(`[Workspace] Loaded ${ws.history.length} messages for user ${userId}`);
    }
    ws.loaded = true;
    return ws;
}

// ─── Compact history to fit within token limit (removes oldest) ───────────────
function compactHistory(userId) {
    const ws = userWorkspaces.get(userId);
    if (!ws || !ws.history) return;

    // Recalculate total tokens, ensuring every message has a token count
    let total = 0;
    for (const msg of ws.history) {
        if (msg.tokens === undefined || msg.tokens === null) {
            msg.tokens = countTokens(msg.content);
        }
        total += (msg.tokens || 0);
    }

    // While over limit, remove from the FRONT (oldest)
    // We keep at least one message to avoid an empty history
    while (total > HISTORY_TOKEN_LIMIT && ws.history.length > 1) {
        const removed = ws.history.shift(); // shift() removes index 0 (oldest)
        if (removed) {
            total -= (removed.tokens || 0);
            console.log(`[Workspace] Compacted history for ${userId}: removed oldest message (${removed.tokens} tokens). Remaining: ${total}`);
        }
    }
}

// ─── Push message, compact, persist to Firebase ───────────────────────────────
async function pushMessage(userId, role, content) {
    const ws     = await ensureLoaded(userId);
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
    countTokens,
    HISTORY_TOKEN_LIMIT,
    GLOBAL_TOKEN_LIMIT,
    userWorkspaces,
};
