'use strict';
const { Sandbox } = require('e2b');
const { getWorkspaceFiles, saveWorkspaceFiles, getVersion, setVersion, saveFile } = require('./firebase');
const crypto = require('crypto');

const E2B_API_KEY        = 'e2b_aa45f3f1633fa67462621a6d29e6d1453738261e';
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes keep-alive
const E2B_TIMEOUT_MS     = SANDBOX_TIMEOUT_MS + 90_000; // E2B-side timeout (slightly longer)

const BASE_WORKSPACE_DIR = '/home/user';
const VERSION_FILE  = 'version.txt';

// Sandbox entries: userId → { sandbox, timer, lastUsed }
const userSandboxEntries = new Map();

// Cached workspace structure to avoid redundant 'find' calls
const cachedStructures = new Map();

// ─── Path helper ──────────────────────────────────────────────────────────────
// Each user has their own isolated sandbox, so workspace is always BASE_WORKSPACE_DIR (root of sandbox).
function resolveInSandbox(userId, relPath) {
    const userWorkspace = BASE_WORKSPACE_DIR;
    if (!relPath || relPath === '.') return userWorkspace;
    if (relPath.startsWith('/'))     return relPath;
    const joined = `${userWorkspace}/${relPath}`;
    return joined;
}

// ─── Generate Version Hash from Firebase Files ────────────────────────────────
function generateVersionHash(files) {
    const keys = Object.keys(files).sort();
    const hash = crypto.createHash('md5');
    for (const key of keys) {
        // Filter out hidden files or node_modules
        if (key.includes('/.') || key.startsWith('.') || key.includes('node_modules')) continue;
        hash.update(key);
        hash.update(files[key]);
    }
    return hash.digest('hex');
}

// ─── Update Cached Structure ──────────────────────────────────────────────────
async function updateCachedStructure(userId, sandbox) {
    try {
        const userWorkspace = resolveInSandbox(userId, '.');
        const lsResult = await sandbox.commands.run(
            `find ${userWorkspace} -maxdepth 2 -not -path '*/.*' -not -path '*/node_modules*' 2>/dev/null`
        );
        const structure = (lsResult.stdout || '')
            .split('\n')
            .filter(Boolean)
            .map(p => p.replace(userWorkspace + '/', ''))
            .filter(p => p !== '' && p !== '.')
            .join('\n');
        cachedStructures.set(userId, structure);
    } catch (e) {
        console.error(`[Sandbox] Failed to update cached structure for ${userId}:`, e.message);
    }
}

function getCachedStructure(userId) {
    return cachedStructures.get(userId);
}

// ─── Inject Firebase workspace into E2B sandbox ───────────────────────────────
async function injectWorkspace(userId, sandbox) {
    try {
        const files = await getWorkspaceFiles(userId);
        const entries = Object.entries(files);
        
        const currentVersion = generateVersionHash(files);

        if (entries.length > 0) {
            for (const [relPath, base64Content] of entries) {
                // Filter
                if (relPath.includes('/.') || relPath.startsWith('.') || relPath.includes('node_modules')) continue;

                try {
                    const fullPath = resolveInSandbox(userId, relPath);
                    const dir      = fullPath.split('/').slice(0, -1).join('/');
                    await sandbox.commands.run(`mkdir -p "${dir}"`);

                    const buffer = Buffer.from(base64Content, 'base64');
                    await sandbox.files.write(fullPath, buffer);
                } catch (e) {
                    console.error(`[Sandbox] injectWorkspace file error (${relPath}):`, e.message);
                }
            }
        }

        await sandbox.files.write(resolveInSandbox(userId, VERSION_FILE), currentVersion);
        await setVersion(userId, currentVersion);

        console.log(`[Sandbox] Injected ${entries.length} file(s) for user ${userId}. Version: ${currentVersion}`);
        
        await updateCachedStructure(userId, sandbox);
        
        return currentVersion;
    } catch (e) {
        console.error(`[Sandbox] injectWorkspace failed for ${userId}:`, e.message);
        return null;
    }
}

// ─── Extract E2B workspace → Firebase ────────────────────────────────────────
async function saveWorkspace(userId) {
    const entry = userSandboxEntries.get(userId);
    if (!entry) return;
    try {
        const { sandbox } = entry;
        const userWorkspace = resolveInSandbox(userId, '.');
        const result = await sandbox.commands.run(
            `find "${userWorkspace}" -type f -not -path '*/.*' -not -path '*/node_modules*' 2>/dev/null`
        );
        const filePaths = (result.stdout || '').split('\n').filter(Boolean);

        const files = {};

        await Promise.all(filePaths.map(async (fullPath) => {
            const relPath = fullPath.replace(`${userWorkspace}/`, '');
            if (relPath === VERSION_FILE) return;

            try {
                const bytes = await sandbox.files.read(fullPath, { format: 'bytes' });
                files[relPath] = Buffer.from(bytes).toString('base64');
            } catch (e) {
                console.error(`[Sandbox] saveWorkspace read error (${fullPath}):`, e.message);
            }
        }));

        let sbVersion = '';
        try {
            sbVersion = await sandbox.files.read(resolveInSandbox(userId, VERSION_FILE));
            sbVersion = sbVersion.trim();
        } catch (_) {}

        const newVersion = generateVersionHash(files);

        if (sbVersion === newVersion) {
            console.log(`[Sandbox] Version unchanged (${newVersion}). Skipping Firebase save for ${userId}.`);
            return;
        }

        await saveWorkspaceFiles(userId, files);
        await setVersion(userId, newVersion);
        await sandbox.files.write(resolveInSandbox(userId, VERSION_FILE), newVersion);

        console.log(`[Sandbox] Saved ${Object.keys(files).length} file(s) for user ${userId}. New version: ${newVersion}`);
        
        await updateCachedStructure(userId, sandbox);
    } catch (e) {
        console.error(`[Sandbox] saveWorkspace failed for ${userId}:`, e.message);
    }
}

// ─── Destroy user sandbox ─────────────────────────────────────
async function destroyUserSandbox(userId) {
    const entry = userSandboxEntries.get(userId);
    if (!entry) return;

    clearTimeout(entry.timer);
    userSandboxEntries.delete(userId);
    cachedStructures.delete(userId);

    console.log(`[Sandbox] Starting total removal of sandbox for user ${userId}...`);

    try { 
        await entry.sandbox.kill(); 
        console.log(`[Sandbox] Sandbox for user ${userId} removed.`);
    } catch (e) {
        console.error(`[Sandbox] Error killing sandbox for ${userId}:`, e.message);
    }
}

// ─── Cleanup ALL existing sandboxes for this API key ──────────────────────────
async function cleanupSandboxes() {
    console.log(`[Sandbox] Cleaning up all active/leaked sandboxes...`);
    try {
        const paginator = await Sandbox.list({ apiKey: E2B_API_KEY });
        let count = 0;
        for await (const sb of paginator) {
            try {
                const id = sb.sandboxId;
                const toKill = await Sandbox.connect(id, { apiKey: E2B_API_KEY });
                await toKill.kill();
                console.log(`[Sandbox] Killed ghost sandbox: ${id}`);
                count++;
            } catch (e) {
                console.warn(`[Sandbox] Failed to kill sandbox ${sb.sandboxId || 'unknown'}:`, e.message);
            }
        }
        if (count === 0) {
            console.log(`[Sandbox] No active sandboxes found.`);
        } else {
            console.log(`[Sandbox] Successfully killed ${count} ghost sandbox(es).`);
        }
    } catch (e) {
        console.error(`[Sandbox] cleanupSandboxes failed:`, e.message);
    }
}

// ─── Check and Sync Workspace ────────────────────────────────────────────────
async function checkAndSync(userId, sandbox) {
    try {
        const fbVersion = await getVersion(userId);
        let sbVersion = '';
        try {
            sbVersion = await sandbox.files.read(resolveInSandbox(userId, VERSION_FILE));
            sbVersion = sbVersion.trim();
        } catch (e) {
            console.log(`[Sandbox] version.txt not found in sandbox for ${userId}, syncing...`);
        }

        if (!fbVersion) return;

        if (sbVersion !== fbVersion) {
            console.log(`[Sandbox] Version mismatch for ${userId} (SB: ${sbVersion} vs FB: ${fbVersion}). Syncing...`);
            await sandbox.commands.run(`rm -rf "${resolveInSandbox(userId, '.')}"/*`);
            await injectWorkspace(userId, sandbox);
        } else {
            if (!getCachedStructure(userId)) await updateCachedStructure(userId, sandbox);
        }
    } catch (e) {
        console.error(`[Sandbox] checkAndSync failed for ${userId}:`, e.message);
    }
}

// ─── Get or create user sandbox ────────────────────────────────────────────
async function getSandbox(userId) {
    let entry = userSandboxEntries.get(userId);

    if (entry) {
        try {
            await entry.sandbox.setTimeout(E2B_TIMEOUT_MS);
        } catch (e) {
            console.warn(`[Sandbox] Sandbox for ${userId} died (${e.message}), recreating...`);
            clearTimeout(entry.timer);
            userSandboxEntries.delete(userId);
            cachedStructures.delete(userId);
            entry = null;
        }
    }

    if (!entry) {
        console.log(`[Sandbox] Creating new sandbox for user ${userId}`);
        const sandbox = await Sandbox.create({
            apiKey:    E2B_API_KEY,
            timeoutMs: E2B_TIMEOUT_MS,
        });

        await sandbox.commands.run(`mkdir -p "${BASE_WORKSPACE_DIR}"`);
        await injectWorkspace(userId, sandbox);

        const timer = setTimeout(() => destroyUserSandbox(userId), SANDBOX_TIMEOUT_MS);
        entry = { sandbox, timer, lastUsed: Date.now() };
        userSandboxEntries.set(userId, entry);
    } else {
        clearTimeout(entry.timer);
        entry.timer    = setTimeout(() => destroyUserSandbox(userId), SANDBOX_TIMEOUT_MS);
        entry.lastUsed = Date.now();
        await checkAndSync(userId, entry.sandbox);
    }

    return entry.sandbox;
}

// ─── Write a single file directly to sandbox + Firebase ──────────────────────
async function writeFileDirect(userId, relPath, buffer) {
    // Filter
    if (relPath.includes('/.') || relPath.startsWith('.') || relPath.includes('node_modules')) return;

    await saveFile(userId, relPath, buffer);

    const entry = userSandboxEntries.get(userId);
    if (entry) {
        try {
            const sandbox = entry.sandbox;
            const fullPath = resolveInSandbox(userId, relPath);
            const dir      = fullPath.split('/').slice(0, -1).join('/');
            await sandbox.commands.run(`mkdir -p "${dir}"`);
            await sandbox.files.write(fullPath, buffer);
            
            const fbFiles = await getWorkspaceFiles(userId);
            const newVersion = generateVersionHash(fbFiles);
            await sandbox.files.write(resolveInSandbox(userId, VERSION_FILE), newVersion);
            await setVersion(userId, newVersion);
            
            await updateCachedStructure(userId, sandbox);
        } catch (e) {
            console.error(`[Sandbox] writeFileDirect sandbox inject failed for ${userId}:`, e.message);
        }
    }
}

async function resetUser(userId) {
    await destroyUserSandbox(userId);
    const { deleteWorkspace } = require('./firebase');
    await deleteWorkspace(userId);
}

function isSandboxActive(userId) {
    return userSandboxEntries.has(userId);
}

module.exports = {
    getSandbox,
    saveWorkspace,
    destroyUserSandbox,
    cleanupSandboxes,
    resetUser,
    writeFileDirect,
    resolveInSandbox,
    getCachedStructure,
    isSandboxActive,
    BASE_WORKSPACE_DIR,
};