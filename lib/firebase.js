'use strict';
const axios = require('axios');

const FIREBASE_URL = 'https://studio-7969231078-4753a-default-rtdb.firebaseio.com';

// ─── Firebase REST helpers ────────────────────────────────────────────────────

async function fbGet(path) {
    const res = await axios.get(`${FIREBASE_URL}/${path}.json`, { timeout: 15_000 });
    return res.data ?? null;
}

async function fbSet(path, data) {
    await axios.put(`${FIREBASE_URL}/${path}.json`, JSON.stringify(data), { 
        timeout: 15_000,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function fbDelete(path) {
    await axios.delete(`${FIREBASE_URL}/${path}.json`, { timeout: 15_000 });
}

// ─── File key encoding ────────────────────────────────────────────────────────
// Firebase keys cannot contain: . $ # [ ] /
// We use base64url (safe chars: A-Z a-z 0-9 - _)

function encodeKey(filePath) {
    return Buffer.from(filePath).toString('base64url');
}

function decodeKey(key) {
    try { return Buffer.from(key, 'base64url').toString(); }
    catch { return key; }
}

// ─── User History ─────────────────────────────────────────────────────────────

async function getHistory(userId) {
    try {
        const data = await fbGet(`users/${userId}/history`);
        if (!data) return null;
        return {
            history:      Array.isArray(data.messages) ? data.messages : [],
            persona:      data.persona      ?? null,
            messageCount: data.messageCount ?? 0,
            createdAt:    data.createdAt    ?? new Date().toISOString(),
        };
    } catch (e) {
        console.error(`[Firebase] getHistory failed for ${userId}:`, e.message);
        return null;
    }
}

async function saveHistory(userId, ws) {
    try {
        await fbSet(`users/${userId}/history`, {
            messages:     ws.history,
            persona:      ws.persona,
            messageCount: ws.messageCount,
            createdAt:    ws.createdAt,
            updatedAt:    new Date().toISOString(),
        });
    } catch (e) {
        console.error(`[Firebase] saveHistory failed for ${userId}:`, e.message);
    }
}

// ─── Workspace Files (stored as base64) ──────────────────────────────────────

/**
 * Returns { decodedPath: base64Content, ... }
 */
async function getWorkspaceFiles(userId) {
    try {
        const raw = await fbGet(`users/${userId}/files`);
        if (!raw) return {};
        const result = {};
        for (const [key, val] of Object.entries(raw)) {
            if (val) result[decodeKey(key)] = val;
        }
        return result;
    } catch (e) {
        console.error(`[Firebase] getWorkspaceFiles failed for ${userId}:`, e.message);
        return {};
    }
}

/**
 * files = { 'relPath': base64string, ... }
 */
async function saveWorkspaceFiles(userId, files) {
    try {
        const encoded = {};
        for (const [filePath, content] of Object.entries(files)) {
            encoded[encodeKey(filePath)] = content;
        }
        const url = `${FIREBASE_URL}/users/${userId}/files.json`;
        await axios.put(url, JSON.stringify(encoded), {
            timeout: 15_000,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error(`[Firebase] saveWorkspaceFiles failed for ${userId}:`, e.message);
    }
}

/**
 * Save a single file (buffer or string) to Firebase.
 */
async function saveFile(userId, relPath, bufferOrString) {
    try {
        const base64 = Buffer.isBuffer(bufferOrString)
            ? bufferOrString.toString('base64')
            : Buffer.from(bufferOrString).toString('base64');
        const key = encodeKey(relPath);
        const url = `${FIREBASE_URL}/users/${userId}/files/${key}.json`;
        await axios.put(url, JSON.stringify(base64), {
            timeout: 15_000,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error(`[Firebase] saveFile failed for ${userId}/${relPath}:`, e.message);
    }
}

async function deleteWorkspace(userId) {
    try {
        await fbDelete(`users/${userId}`);
    } catch (e) {
        console.error(`[Firebase] deleteWorkspace failed for ${userId}:`, e.message);
    }
}

async function getVersion(userId) {
    const url = `${FIREBASE_URL}/users/${userId}/version.json`;
    console.log(`[Firebase] Fetching version from: ${url}`);
    const res = await axios.get(url, { timeout: 15_000 });
    console.log(`[Firebase] Version response:`, res.data);
    return res.data ?? null;
}

async function setVersion(userId, version) {
    const url = `${FIREBASE_URL}/users/${userId}/version.json`;
    console.log(`[Firebase] Setting version at: ${url}`);
    // Firebase REST API requires strings to be double-quoted in the request body
    await axios.put(url, JSON.stringify(version), { 
        timeout: 15_000,
        headers: { 'Content-Type': 'application/json' }
    });
}

module.exports = {
    fbGet,
    fbSet,
    fbDelete,
    encodeKey,
    decodeKey,
    getHistory,
    saveHistory,
    getWorkspaceFiles,
    saveWorkspaceFiles,
    saveFile,
    deleteWorkspace,
    getVersion,
    setVersion,
};
