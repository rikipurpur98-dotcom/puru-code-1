'use strict';
const { Telegraf, Markup } = require('telegraf');
const axios                = require('axios');
const { XMLParser }        = require('fast-xml-parser');

const {
    getWorkspace,
    ensureLoaded,
    pushMessage,
    getTotalTokens,
    HISTORY_TOKEN_LIMIT,
    GLOBAL_TOKEN_LIMIT,
} = require('./lib/workspace');

const { saveWorkspace, writeFileDirect, cleanupSandboxes } = require('./lib/sandbox');
const tools = require('./lib/tools');

// ─── Global Error Handlers ────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) =>
    console.error('[FATAL] Unhandled Rejection:', reason));
process.on('uncaughtException', (err) =>
    console.error('[FATAL] Uncaught Exception:', err));

// ─── Bot Setup ────────────────────────────────────────────────────────────────
const config = require('./config.json');
const env = process.env.NODE_ENV || 'production';
const BOT_TOKEN = config[env]?.BOT_TOKEN || config.production.BOT_TOKEN;
const bot       = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 600_000, // 10 minutes
});

bot.catch((err, ctx) => {
    if (err.response?.description?.includes('query is too old')) return;
    console.error(`[Error] ${ctx.updateType}:`, err.message);
});

// ─── Constants ────────────────────────────────────────────────────────────────
const AI_API_URL     = 'https://puruboy-api.vercel.app/api/ai/gemini-v2';
const MAX_PURU_LOOPS = 10;
const MAX_CODE_LOOPS = 10;
const RETRY_COUNT    = 3;
const RETRY_DELAY_MS = 3000;

// ─── Pending Continue state ───────────────────────────────────────────────────
const pendingLoops = new Map();

// ─── XML Parser — CDATA-aware ─────────────────────────────────────────────────
const xmlParser = new XMLParser({
    cdataPropName:    '__cdata',
    parseTagValue:    false,
    trimValues:       false,
    ignoreAttributes: true,
    processEntities:  false, // Don't decode HTML entities automatically
});

function xmlVal(v) {
    if (v === undefined || v === null)          return '';
    if (typeof v === 'object' && v.__cdata !== undefined) return String(v.__cdata);
    if (typeof v === 'object' && v['#text'] !== undefined) return String(v['#text']);
    if (typeof v === 'object')                  return JSON.stringify(v);
    return String(v);
}

// ─── Parse Puru (Orchestrator) Response ──────────────────────────────────────
function parsePuruResponse(text) {
    const responseMatch = text.match(/<response[\s\S]*?<\/response\s*>/i);
    if (!responseMatch) return { message: text.trim(), delegate: null, sendFile: null };

    try {
        const parsed  = xmlParser.parse(responseMatch[0]);
        const resp    = parsed?.response || {};
        const message = xmlVal(resp.message).trim();

        let delegate = null;
        if (resp.delegate) {
            const task = typeof resp.delegate === 'object'
                ? xmlVal(resp.delegate.task).trim()
                : String(resp.delegate).trim();
            if (task) delegate = { task };
        }

        let sendFile = null;
        if (resp.send_file && typeof resp.send_file === 'object') {
            sendFile = {
                path:    xmlVal(resp.send_file.path),
                caption: xmlVal(resp.send_file.caption),
            };
        }

        return { message, delegate, sendFile };
    } catch (e) {
        console.error('[Puru XML Parse Error]', e.message);
        const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { message: stripped, delegate: null, sendFile: null };
    }
}

// ─── Parse Code (Sub-Agent) Response ─────────────────────────────────────────
function parseCodeResponse(text) {
    const responseMatch = text.match(/<response[\s\S]*?<\/response\s*>/i);
    if (!responseMatch) return { message: text.trim(), toolCall: null };

    const rawXml = responseMatch[0];
    let message = '';
    let toolCall = null;

    try {
        const parsed = xmlParser.parse(rawXml);
        const resp = parsed?.response || {};
        message = xmlVal(resp.message).trim();

        if (resp.tool && typeof resp.tool === 'object') {
            const action = Object.keys(resp.tool).find(k => k !== '__cdata' && k !== '#text' && tools[k]);
            if (action) {
                const actionContent = resp.tool[action];
                const params = {};
                if (actionContent && typeof actionContent === 'object') {
                    for (const [k, v] of Object.entries(actionContent)) {
                        if (k !== '__cdata' && k !== '#text') params[k] = xmlVal(v);
                    }
                }
                toolCall = { action, params };
            }
        }
    } catch (e) {
        console.error('[Code XML Parse Error]', e.message);
    }

    // Fallback: Manual extraction if toolCall is still null or parameters look like they were mangled
    if (!toolCall) {
        const toolMatch = rawXml.match(/<tool\s*>([\s\S]*?)<\/tool\s*>/i);
        if (toolMatch) {
            const innerTool = toolMatch[1];
            for (const actionName of Object.keys(tools)) {
                const actionMatch = innerTool.match(new RegExp(`<${actionName}\\s*>([\\s\S]*?)<\\/${actionName}\\s*>`, 'i'));
                if (actionMatch) {
                    const paramsContent = actionMatch[1];
                    const params = {};
                    const paramTags = paramsContent.match(/<([^>/]+)\s*>([\s\S]*?)<\/\1\s*>/g) || [];
                    for (const tag of paramTags) {
                        const m = tag.match(/<([^>/]+)\s*>([\s\S]*?)<\/\1\s*>/i);
                        if (m) {
                            let val = m[2].trim();
                            if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) {
                                val = val.slice(9, -3);
                            }
                            params[m[1]] = val;
                        }
                    }
                    toolCall = { action: actionName, params };
                    break;
                }
            }
        }
    }

    if (!message) {
        const msgMatch = rawXml.match(/<message\s*>([\s\S]*?)<\/message\s*>/i);
        if (msgMatch) {
            message = msgMatch[1].trim();
            if (message.startsWith('<![CDATA[') && message.endsWith(']]>')) {
                message = message.slice(9, -3);
            }
        }
    }

    if (!message && !toolCall) {
        const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { message: stripped, toolCall: null };
    }

    return { message, toolCall };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPTS
// ═══════════════════════════════════════════════════════════════════════════════

const PURU_BASE_SYSTEM_PROMPT = `You are Puru, an AI Orchestrator and the SINGLE POINT OF CONTACT for the user.
You coordinate tasks by delegating to a specialist Code Sub-Agent named "Code".

PERSONA & STYLE:
- Mirror the user's language style. Informal if they're informal, formal if formal.
- Jaksel style (mixed Indonesian-English) is fine if user uses it.
- Friendly, smart, relaxed but competent.

YOUR ROLE:
- Receive user requests and break them into small, sequential sub-tasks.
- Delegate ONE sub-task at a time to Code Agent. Never batch multiple tasks at once.
- Receive Code Agent's result and decide: done, give final answer; or continue, next sub-task.
- Package all results into a clear, friendly final answer for the user.

RESPONSE FORMAT (XML):

When delegating a sub-task to Code Agent:
<response>
  <message>Brief status or thinking for user (optional)</message>
  <delegate>
    <task>Complete, self-contained instruction for Code Agent. Be specific. Include file paths, what to read/check first, what to change.</task>
  </delegate>
</response>

When giving final answer (no more delegation needed):
<response>
  <message>Final answer to user. Clear and friendly.</message>
</response>

When you need to send a file to the user:
<response>
  <message>Sending the file...</message>
  <send_file>
    <path>path/to/file</path>
    <caption>optional caption</caption>
  </send_file>
</response>

RULES:
- NEVER delegate multiple tasks at once. ONE sub-task per response.
- Code Agent is STATELESS — every instruction must be self-sufficient.
- If Code Agent result is incomplete, delegate the next sub-task.
- History is auto-summarized at ${HISTORY_TOKEN_LIMIT} tokens (Puru).
- Global system token budget: ${GLOBAL_TOKEN_LIMIT} tokens.
- Avoid nested asterisks or complex Markdown in <message>. Use '-' for lists.`;

const CODE_SYSTEM_PROMPT = `You are Code, a specialist Code Sub-Agent under the Puru Orchestrator system.

IDENTITY:
- You are STATELESS — you have NO memory of previous conversations.
- You receive ONE specific sub-task per session from Puru (Orchestrator).
- You execute it inside a real E2B cloud sandbox.

SANDBOX ENVIRONMENT:
- OS: Linux (Ubuntu)
- Your workspace root: /home/user  (semua file project berada di sini — ini adalah root path sandbox)
- Full shell access via bash tool — internet-enabled, any package installable via apt/pip/npm
- All tools run inside this isolated sandbox. Changes persist for your session.

MANDATORY PROCEDURE — BEFORE EDITING ANY FILE:
1. ALWAYS use read_file (or ls) to read and display the file content FIRST.
2. Only after reading and confirming the content, proceed with edits.
3. Never assume file content — always verify first.

RESPONSE FORMAT (XML):
<response>
<message>Your status or explanation</message>
<tool>
    <action_name>
        <param_name>value</param_name>
    </action_name>
</tool>
</response>

CRITICAL:
- ONE tool, ONE action per response. Never call multiple tools at once.
- If no tool needed, omit the <tool> block.
- MANDATORY: Use <![CDATA[ ]]> for ANY content that contains special characters, HTML, or code (especially in write_file and edit_file).

AVAILABLE TOOLS:
1. ls         — List files.    <ls><path>.</path></ls>
2. read_file  — Read lines.    <read_file><path>f</path><start_line>1</start_line><end_line>50</end_line></read_file>
3. write_file — Write file.    <write_file><path>f</path><content><![CDATA[text]]></content></write_file>
4. edit_file  — Replace text.  <edit_file><path>f</path><old_string><![CDATA[a]]></old_string><new_string><![CDATA[b]]></new_string></edit_file>
5. grep       — Search.        <grep><path>f</path><pattern>keyword</pattern></grep>
6. bash       — Shell (max 2m).<bash><command><![CDATA[cmd]]></command></bash>

RULES:
- File paths can be relative (resolved to /home/user) or absolute. The project root is /home/user.
- Match user language (English / Indonesian / Mixed).
- Be precise and complete the sub-task fully.`;

// ─── Build Puru conversation ──────────────────────────────────────────────────
async function buildConversation(userId) {
    const ws           = await ensureLoaded(userId);
    let   systemPrompt = PURU_BASE_SYSTEM_PROMPT;

    // ─── Inject Workspace Structure ──────────────────────────────────────────
    try {
        const { getCachedStructure } = require('./lib/sandbox');
        const files = getCachedStructure(userId) || '(kosong)';
        
        systemPrompt += `\n\n═══ WORKSPACE STRUCTURE ═══\n${files}`;
    } catch (e) {
        console.error('[BuildConv] Failed to inject workspace structure:', e.message);
    }

    if (ws.persona) {
        systemPrompt += `\n\n═══ CUSTOM PERSONA (override default style) ═══\n${ws.persona}`;
    }
    const historyText = ws.history.map(m => {
        if (m.role === 'user')      return `User: ${m.content}`;
        if (m.role === 'assistant') return `Assistant: ${m.content}`;
        if (m.role === 'output')    return `Code Agent Result: ${m.content}`;
        return `${m.role}: ${m.content}`;
    }).join('\n');
    console.log(`[BuildConv] Building history for ${userId}. Messages: ${ws.history.length}`);
    return `System: ${systemPrompt}\n\n${historyText}`;
}

// ─── API call with retry ──────────────────────────────────────────────────────
async function callAIWithRetry(ctx, statusMsgId, payload) {
    let lastError;
    for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
        try {
            return await axios({
                method:  'post',
                url:     AI_API_URL,
                data:    payload,
                headers: { 'Content-Type': 'application/json' },
                timeout: 60_000,
            });
        } catch (err) {
            lastError = err;
            const errDesc =
                err.response?.data?.message ||
                err.response?.data?.error   ||
                err.code                    ||
                err.message                 ||
                'Unknown error';

            console.warn(`[API] Attempt ${attempt}/${RETRY_COUNT} failed: ${errDesc}`);

            if (attempt < RETRY_COUNT) {
                const retryText =
                    `⚠️ *API Error (percobaan ${attempt}/${RETRY_COUNT}):*\n` +
                    `\`${errDesc}\`\n\n🔄 Mencoba ulang dalam 3 detik...`;
                try {
                    if (statusMsgId) {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id, statusMsgId, null,
                            retryText, { parse_mode: 'Markdown' }
                        );
                    } else {
                        await ctx.reply(retryText, { parse_mode: 'Markdown' });
                    }
                } catch (_) {}
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE SUB-AGENT RUNNER
// ═══════════════════════════════════════════════════════════════════════════════
async function callCodeAgent(ctx, userId, subTask) {
    let conversation    = `System: ${CODE_SYSTEM_PROMPT}\n\nUser: ${subTask}`;
    let iteration       = 0;
    const interimMsgIds = [];

    while (iteration < MAX_CODE_LOOPS) {
        await ctx.sendChatAction('typing').catch(() => {});
        const typingHB = setInterval(() =>
            ctx.sendChatAction('typing').catch(() => {}), 4000);

        let rawText = '';
        try {
            const response = await callAIWithRetry(ctx, null,
                { prompt: conversation + '\nAssistant:' }
            );
            rawText = response.data?.result?.answer || response.data?.answer || '';
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);
        } catch (err) {
            clearInterval(typingHB);
            for (const id of interimMsgIds) {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) {}
            }
            return `[Code Agent Error]: ${err.message}`;
        } finally {
            clearInterval(typingHB);
        }

        const { message, toolCall } = parseCodeResponse(rawText);

        // No tool → Code Agent is done
        if (!toolCall) {
            const finalText = message || rawText
                .replace(/<response\s*>/gi,  '')
                .replace(/<\/response\s*>/gi, '')
                .replace(/<message\s*>([\s\S]*?)<\/message\s*>/gi, '$1')
                .trim();

            for (const id of interimMsgIds) {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) {}
            }
            return finalText || rawText;
        }

        // Show Code Agent thinking (interim)
        if (message) {
            try {
                const sent = await ctx.reply(`🔧 *Code:* ${message}`, { parse_mode: 'Markdown' });
                interimMsgIds.push(sent.message_id);
            } catch (_) {}
        }

        // Execute tool in E2B sandbox
        try {
            const { action, params } = toolCall;
            const result = await Promise.resolve(tools[action](userId, params, ctx));

            // Show tool execution feedback (interim)
            try {
                const label   = action === 'send_file' ? '📤 send_file' : `🛠️ ${action}`;
                const preview = String(result).slice(0, 2000);
                const toolMsg = await ctx.replyWithMarkdown(
                    `${label} \`→\` \`${preview}\``
                );
                interimMsgIds.push(toolMsg.message_id);
            } catch (_) {}

            const paramsXml = Object.entries(params)
                .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
                .join('');

            conversation +=
                `\nAssistant: <response><message>${message}</message>` +
                `<tool><${action}>${paramsXml}</${action}></tool></response>` +
                `\nTool Result (${action}): ${result}`;

            iteration++;
        } catch (e) {
            try {
                const errMsg = await ctx.replyWithMarkdown(
                    `❌ *Code Tool Error:* \`${toolCall.action || '?'}\`\n\`${e.message}\``
                );
                interimMsgIds.push(errMsg.message_id);
            } catch (_) {}
            conversation += `\nAssistant: ${rawText}\nTool Error: ${e.message}`;
        }
    }

    for (const id of interimMsgIds) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) {}
    }
    return '[Code Agent]: Mencapai batas iterasi tool.';
}

// ═══════════════════════════════════════════════════════════════════════════════
// PURU ORCHESTRATION LOOP
// ═══════════════════════════════════════════════════════════════════════════════
async function processPuruOrchestration(ctx, userId, statusMsgId, loopState = null) {
    let puruConversation = loopState?.conversation || await buildConversation(userId);
    let puruIteration    = loopState?.iteration    || 0;
    const interimMsgIds  = [];

    while (puruIteration < MAX_PURU_LOOPS) {
        await ctx.sendChatAction('typing').catch(() => {});
        const typingHB = setInterval(() =>
            ctx.sendChatAction('typing').catch(() => {}), 4000);

        let rawText = '';
        try {
            const response = await callAIWithRetry(
                ctx,
                puruIteration === 0 ? statusMsgId : null,
                { prompt: puruConversation + '\nAssistant:' }
            );
            rawText = response.data?.result?.answer || response.data?.answer || '';
            if (typeof rawText !== 'string') rawText = JSON.stringify(rawText);
        } catch (err) {
            clearInterval(typingHB);
            const errDesc =
                err.response?.data?.message ||
                err.response?.data?.error   ||
                err.code                    ||
                err.message                 ||
                'Unknown error';
            return {
                type: 'error',
                text: `❌ *API gagal setelah ${RETRY_COUNT}x percobaan.*\n\nError: \`${errDesc}\`\n\nCoba lagi dalam beberapa menit ya!`,
                interimMsgIds,
            };
        } finally {
            clearInterval(typingHB);
        }

        const { message, delegate, sendFile } = parsePuruResponse(rawText);

        // Tool: send_file (directly from Puru)
        if (sendFile) {
            try {
                const result = await tools.send_file(userId, sendFile, ctx);
                await pushMessage(userId, 'output', `[Puru send_file]: ${result}`);
                puruConversation +=
                    `\nAssistant: <response><message>${message}</message>` +
                    `<send_file><path>${sendFile.path}</path><caption>${sendFile.caption || ''}</caption></send_file></response>` +
                    `\nTool Result (send_file): ${result}`;
                puruIteration++;
                continue;
            } catch (e) {
                console.error('[Puru send_file Error]', e.message);
                // Instead of just adding error text, add the error to conversation AND break loop
                // to avoid infinite loops or silent failure.
                puruConversation += `\nAssistant: <response><message>${message}</message></response>\nTool Error (send_file): ${e.message}`;
                return {
                    type: 'error',
                    text: `❌ *Error saat mengirim file:* \`${e.message}\`\n\nPuru berhenti untuk mencegah error berulang.`,
                    interimMsgIds,
                };
            }
        }

        // No delegation → final answer
        if (!delegate) {
            const finalText = message || rawText
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            return { type: 'final', text: finalText, interimMsgIds };
        }

        // Show Puru's planning message (interim)
        if (message) {
            try {
                const sent = await ctx.reply(`🧠 *Puru:* ${message}`, { parse_mode: 'Markdown' });
                interimMsgIds.push(sent.message_id);
            } catch (_) {}
        }

        // Show delegation status (interim)
        try {
            const taskPreview = delegate.task.slice(0, 180);
            const delegateMsg = await ctx.reply(
                `⚙️ *Mendelegasikan ke Code Agent...*\n_${taskPreview}${delegate.task.length > 180 ? '…' : ''}_`,
                { parse_mode: 'Markdown' }
            );
            interimMsgIds.push(delegateMsg.message_id);
        } catch (_) {}

        // Call Code Agent (stateless — E2B sandbox for specific user)
        const codeResult = await callCodeAgent(ctx, userId, delegate.task);

        // ── After each Code Agent loop, persist workspace → Firebase ──────────
        await saveWorkspace(userId).catch(e =>
            console.error('[Orchestration] saveWorkspace error:', e.message)
        );

        // Push Code result to Puru's history
        await pushMessage(userId, 'output',
            `[Code Agent Result]: ${String(codeResult).slice(0, 600)}`
        );

        // Feed result back into Puru's active conversation
        puruConversation +=
            `\nAssistant: <response><message>${message}</message>` +
            `<delegate><task>${delegate.task}</task></delegate></response>` +
            `\nCode Agent Result: ${codeResult}`;

        puruIteration++;
    }

    // ── Explicitly destroy user sandbox after loop ───────────────────────────
    await require('./lib/sandbox').destroyUserSandbox(userId);

    return {
        type:         'error',
        text:         '⚠️ *Puru gagal menyelesaikan tugas.* Terlalu banyak loop (10 delegasi). Coba pecah permintaan kamu jadi lebih sederhana.',
        interimMsgIds,
    };
}

// ─── Handle orchestration result ──────────────────────────────────────────────
async function handleAgentResult(ctx, userId, result, statusMsgId) {
    // Delete status + interim messages
    const toDelete = [...(result.interimMsgIds || []), statusMsgId].filter(Boolean);
    for (const msgId of toDelete) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, msgId); } catch (_) {}
    }

    if (result.type === 'final' || result.type === 'error') {
        await pushMessage(userId, 'assistant', result.text);
        try {
            await ctx.replyWithMarkdown(result.text);
        } catch (_) {
            try { await ctx.reply(result.text); } catch (_) {}
        }
    }
}

// ─── /stop ──────────────────────────────────────────────────────────────────
bot.command('stop', async (ctx) => {
    const userId = ctx.from.id;
    const ws = getWorkspace(userId);
    if (ws.processing) {
        ws.processing = false; // Stop the orchestration loop
        await ctx.reply('🛑 Proses AI telah dihentikan.');
    } else {
        await ctx.reply('ℹ️ Tidak ada proses AI yang sedang berjalan.');
    }
});
// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
    await ctx.reply(
        '🌟 *Puru Orchestrator v4.0* 🌟\n\n' +
        '🧠 *Puru* — Orchestrator, single point of contact\n' +
        '🔧 *Code* — Stateless sub-agent, eksekusi di E2B Sandbox\n\n' +
        '• Eksekusi di E2B cloud sandbox ✅\n' +
        '• Sandbox keep-alive 5 menit per user ✅\n' +
        '• Workspace & history tersimpan di Firebase ✅\n' +
        '• Workspace auto-inject ke sandbox baru ✅\n' +
        '• Auto-save ke Firebase setiap loop selesai ✅\n' +
        '• Tidak ada penyimpanan lokal ✅',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📊 Info', 'menu_info')],
                [Markup.button.callback('♻️ Reset', 'menu_reset')],
                [Markup.button.callback('❓ Help', 'menu_help')],
            ]),
        }
    );
});

// ─── Document upload ──────────────────────────────────────────────────────────
bot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const ws = getWorkspace(userId);
    if (ws.processing)
        return ctx.reply('⏳ Tunggu respons sebelumnya selesai dulu ya!');

    const { document } = ctx.message;
    const fileName     = document.file_name;
    const caption      = ctx.message.caption || '';
    const relPath      = `uploads/${fileName}`;

    ws.processing = true;
    let statusMsg;
    try {
        await ctx.sendChatAction('upload_document');

        // Download file from Telegram as Buffer
        const link     = await ctx.telegram.getFileLink(document.file_id);
        const fileResp = await axios({ method: 'get', url: link.href, responseType: 'arraybuffer' });
        const buffer   = Buffer.from(fileResp.data);

        // Save to Firebase + inject into sandbox (if running)
        await writeFileDirect(userId, relPath, buffer);

        statusMsg = await ctx.reply('📎 File diupload! Puru sedang menganalisis... ⏳');
        await pushMessage(userId, 'user',
            `[User mengupload file: ${relPath}]${caption ? ' ' + caption : ''}`
        );

        const result = await processPuruOrchestration(ctx, userId, statusMsg.message_id);
        await handleAgentResult(ctx, userId, result, statusMsg.message_id);

    } catch (e) {
        console.error('[Doc Error]', e);
        try { await ctx.reply('❌ Gagal upload file: ' + e.message); } catch (_) {}
    } finally {
        ws.processing = false;
    }
});

// ─── Load Plugins ─────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const pluginsPath = path.join(__dirname, 'plugins');
if (fs.existsSync(pluginsPath)) {
    fs.readdirSync(pluginsPath)
        .filter(f => f.endsWith('.js'))
        .forEach(f => require(path.join(pluginsPath, f))(bot));
}

// ─── Text Handler ─────────────────────────────────────────────────────────────
bot.on('text', async (ctx, next) => {
    let userMessage = ctx.message.text;
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const prefixes = ['/ai ', '!ai ', '.ai ', '/ai', '!ai', '.ai'];
    
    let hasPrefix = false;
    let prefixUsed = '';

    for (const p of prefixes) {
        if (userMessage.toLowerCase().startsWith(p)) {
            hasPrefix = true;
            prefixUsed = p;
            break;
        }
    }

    if (isGroup && !hasPrefix) return;

    // Strip prefix if present
    if (hasPrefix) {
        userMessage = userMessage.slice(prefixUsed.length).trim();
    }

    if (ctx.message.text.startsWith('/') && !hasPrefix) return next();
    if (userMessage === '' && hasPrefix) return ctx.reply('Mau tanya apa nih? Ketik pesan setelah prefix ya!');

    const userId = ctx.from.id;
    if (!userId) {
        console.error('[FATAL] User ID is missing in text handler!');
        return;
    }
    const ws = getWorkspace(userId);
    if (ws.processing)
        return ctx.reply('⏳ Tunggu respons sebelumnya selesai dulu ya!');

    // "continue" resumes a pending orchestration loop
    if (userMessage.trim().toLowerCase() === 'continue') {
        const state = pendingLoops.get(userId);
        if (state) {
            pendingLoops.delete(userId);
            ws.processing = true;
            let statusMsg;
            try {
                statusMsg = await ctx.reply('🔄 Melanjutkan orchestration... ⏳');
                const result = await processPuruOrchestration(
                    ctx, userId, statusMsg.message_id, state
                );
                await handleAgentResult(ctx, userId, result, statusMsg.message_id);
            } finally {
                ws.processing = false;
            }
            return;
        }
    }

    // Normal message → Puru orchestration
    ws.processing = true;
    let statusMsg;
    try {
        await pushMessage(userId, 'user', userMessage);
        statusMsg = await ctx.reply('🧠 Puru sedang berpikir... ⏳');
        const result = await processPuruOrchestration(ctx, userId, statusMsg.message_id);
        await handleAgentResult(ctx, userId, result, statusMsg.message_id);
    } finally {
        ws.processing = false;
    }
});

// ─── Launch ───────────────────────────────────────────────────────────────────
(async () => {
    try {
        // Kill all ghost sandboxes before starting
        await cleanupSandboxes();

        await bot.telegram.setMyCommands([
            { command: 'start',   description: 'Mulai bot' },
            { command: 'ai',      description: 'Gunakan AI' },
            { command: 'stop',    description: 'Hentikan proses aktif' },
            { command: 'menu',    description: 'Buka menu utama' },
            { command: 'info',    description: 'Status workspace & token' },
            { command: 'persona', description: 'Set persona AI' },
            { command: 'reset',   description: 'Reset workspace & history' },
            { command: 'help',    description: 'Bantuan' },
        ]);
        await bot.launch();
        console.log('✅ Puru Orchestrator v4.0 running (E2B + Firebase)');
    } catch (e) {
        console.error('[FATAL] Failed to launch bot:', e);
    }
})();

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
