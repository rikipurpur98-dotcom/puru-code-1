'use strict';
const { getSandbox, resolveInSandbox } = require('./sandbox');

const BASH_TIMEOUT_MS  = 120_000;   // 2 minutes
const MAX_FILE_SEND_MB = 50;

const tools = {

    // ─── ls: list files/dirs inside sandbox ─────────────────────────────────
    ls: async (userId, params) => {
        const sandbox  = await getSandbox(userId);
        const target   = resolveInSandbox(userId, params.path || '.');
        const result   = await sandbox.commands.run(`ls -la "${target}" 2>&1`);
        const out      = (result.stdout || '') + (result.stderr || '');
        return out.trim() || '(direktori kosong)';
    },

    // ─── read_file: read lines from file in sandbox ──────────────────────────
    read_file: async (userId, params) => {
        if (!params.path) throw new Error('Missing <path>');
        const sandbox  = await getSandbox(userId);
        const fullPath = resolveInSandbox(userId, params.path);

        if (params.start_line && params.end_line) {
            const s = parseInt(params.start_line, 10);
            const e = parseInt(params.end_line, 10);
            const r = await sandbox.commands.run(`sed -n '${s},${e}p' "${fullPath}" 2>&1`);
            return (r.stdout || r.stderr || '').trim();
        }

        const bytes = await sandbox.files.read(fullPath, { format: 'bytes' });
        return Buffer.from(bytes).toString('utf8');
    },

    // ─── write_file: write content into sandbox ──────────────────────────────
    write_file: async (userId, params) => {
        if (!params.path || params.content === undefined)
            throw new Error('Missing <path> or <content>');
        const sandbox  = await getSandbox(userId);
        const fullPath = resolveInSandbox(userId, params.path);
        const dir      = fullPath.split('/').slice(0, -1).join('/');
        await sandbox.commands.run(`mkdir -p "${dir}"`);
        await sandbox.files.write(fullPath, params.content);
        return `File written: ${params.path} (${params.content.length} chars)`;
    },

    // ─── edit_file: find-and-replace in file inside sandbox ─────────────────
    edit_file: async (userId, params) => {
        if (!params.path || !params.old_string || params.new_string === undefined)
            throw new Error('Missing params');
        const sandbox  = await getSandbox(userId);
        const fullPath = resolveInSandbox(userId, params.path);
        const bytes    = await sandbox.files.read(fullPath, { format: 'bytes' });
        const content  = Buffer.from(bytes).toString('utf8');
        if (!content.includes(params.old_string))
            return 'Error: old_string not found in file.';
        const updated = content.replace(params.old_string, params.new_string);
        await sandbox.files.write(fullPath, updated);
        return 'File edited successfully.';
    },

    // ─── grep: search for pattern in file inside sandbox ────────────────────
    grep: async (userId, params) => {
        if (!params.path || !params.pattern)
            throw new Error('Missing <path> or <pattern>');
        const sandbox  = await getSandbox(userId);
        const fullPath = resolveInSandbox(userId, params.path);
        // Escape pattern for shell safety
        const escaped = params.pattern.replace(/'/g, "'\\''");
        const result  = await sandbox.commands.run(
            `grep -n '${escaped}' "${fullPath}" 2>&1`
        );
        return (result.stdout || '').trim() || 'No matches found.';
    },

    // ─── bash: run arbitrary shell command in sandbox (2-min timeout) ────────
    bash: async (userId, params) => {
        if (!params.command) throw new Error('Missing <command>');
        const sandbox = await getSandbox(userId);
        // Ensure cwd is user's workspace
        const userWorkspace = resolveInSandbox(userId, '.');
        const result  = await sandbox.commands.run(params.command, {
            cwd:     userWorkspace,
            timeout: BASH_TIMEOUT_MS,
        });

        if (result.error) {
            const code = result.error.code || '';
            if (code === 'ETIMEDOUT' || String(result.error).includes('timeout'))
                return '⏰ Bash Error: Timeout (2 menit). Proses dihentikan paksa.';
            return `Bash Error: ${result.error.message || result.error}`;
        }

        const out = (result.stdout || '') +
                    (result.stderr ? `\n[stderr]\n${result.stderr}` : '');
        return out.trim() || 'Success (no output).';
    },

    // ─── send_file: read from sandbox and send to user via Telegram ──────────
    send_file: async (userId, params, ctx) => {
        if (!params.path) throw new Error('Missing <path>');
        if (!ctx)         throw new Error('send_file membutuhkan Telegram context');

        const sandbox  = await getSandbox(userId);
        const fullPath = resolveInSandbox(userId, params.path);

        // Check file exists
        const checkResult = await sandbox.commands.run(
            `test -f "${fullPath}" && echo "EXISTS" || echo "NOT_FOUND"`
        );
        if ((checkResult.stdout || '').trim() === 'NOT_FOUND')
            throw new Error(`File tidak ditemukan di sandbox: ${params.path}`);

        // Read as bytes (handles binary + text files)
        const bytes    = await sandbox.files.read(fullPath, { format: 'bytes' });
        const buffer   = Buffer.from(bytes);
        const sizeMB   = buffer.length / (1024 * 1024);

        if (sizeMB > MAX_FILE_SEND_MB)
            throw new Error(`File terlalu besar (${sizeMB.toFixed(1)} MB, maks ${MAX_FILE_SEND_MB} MB)`);

        const filename = fullPath.split('/').pop();
        const caption  = params.caption ? String(params.caption).slice(0, 1024) : undefined;

        await ctx.replyWithDocument(
            { source: buffer, filename },
            caption ? { caption } : {}
        );

        return `✅ File berhasil dikirim: ${params.path} (${(buffer.length / 1024).toFixed(1)} KB)`;
    },
};

module.exports = tools;
