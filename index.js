'use strict';

global.AI_MOCK_RESPONSE = null;

const { Telegraf, Markup } = require('telegraf');
const axios                = require('axios');
const { XMLParser }        = require('fast-xml-parser');

const {
    getWorkspace,
    ensureLoaded,
    pushMessage,
} = require('./lib/workspace');

const { saveWorkspace, writeFileDirect, cleanupSandboxes, getSandbox, resolveInSandbox, destroyUserSandbox } = require('./lib/sandbox');
const tools = require('./lib/tools');
const {
    ORCHESTRATOR_CONFIG,
    CODE_AGENT_CONFIG,
    ARCHITECT_CONFIG,
    HISTORY_TOKEN_LIMIT,
    GLOBAL_TOKEN_LIMIT
} = require('./lib/prompts');

const AGENT_LABELS = {
    PURU: {
        CHAT: '👤 *Puru:*',
        LOG: '[👤 Puru]'
    },
    CODE: {
        CHAT: '🧑‍💻 *Code:*',
        LOG: '[🧑‍💻 Code Agent]'
    },
    ARCHITECT: {
        CHAT: '🏗️ *Architect:*',
        LOG: '[🏗️ Architect]'
    }
};

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

// ─── Global Reply Middleware ──────────────────────────────────────────────────
// Automatically makes all bot responses reply to the user's original message
bot.use(async (ctx, next) => {
    const msgId = ctx.message?.message_id;
    if (msgId) {
        const wrap = (method) => {
            const original = ctx[method];
            ctx[method] = (text, extra) => {
                return original.call(ctx, text, { reply_to_message_id: msgId, ...extra });
            };
        };
        ['reply', 'replyWithMarkdown', 'replyWithDocument', 'replyWithPhoto'].forEach(wrap);
    }
    return next();
});

// ─── Constants ────────────────────────────────────────────────────────────────
const AI_API_URL          = 'https://puruboy-api.vercel.app/api/ai/gemini-v2';
const FALLBACK_AI_API_URL = 'https://puruboy-api.vercel.app/api/ai/gemini';
const MAX_PURU_LOOPS      = 100;
const MAX_CODE_LOOPS      = 100;
const MAX_TOTAL_RETRIES   = 5;
const RETRY_DELAY_MS      = 3000;

// ─── Pending Continue state ───────────────────────────────────────────────────
const pendingLoops = new Map();

// ─── XML Parser — CDATA-aware ─────────────────────────────────────────────────
const xmlParser = new XMLParser({
    cdataPropName:    '__cdata',
    parseTagValue:    false,
    trimValues:       false,
    ignoreAttributes: false,
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
        const rawXml = responseMatch[0];
        const sanitizedXml = rawXml.replace(/&(?!(amp|lt|gt|quot|apos);)/g, '&amp;');
        const parsed  = xmlParser.parse(sanitizedXml);
        const resp    = parsed?.response || {};
        const message = xmlVal(resp.message).trim();

        let delegate = null;
        if (resp.delegate) {
            const delegateObj = typeof resp.delegate === 'object' ? resp.delegate : { '#text': resp.delegate };
            const task = xmlVal(delegateObj.task).trim();
            if (task) {
                delegate = {
                    task,
                    agent: delegateObj['@_agent'] || 'Code'
                };
            }
        }

        let sendFile = null;
        if (resp.send_file && typeof resp.send_file === 'object') {
            sendFile = {
                path:    xmlVal(resp.send_file.path),
                caption: xmlVal(resp.send_file.caption),
            };
        }

        let lsCall = null;
        if (resp.ls) {
            if (typeof resp.ls === 'object') {
                lsCall = { path: xmlVal(resp.ls.path) || '.' };
            } else {
                lsCall = { path: xmlVal(resp.ls) || '.' };
            }
        }

        return { message, delegate, sendFile, lsCall };
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
        const sanitizedXml = rawXml.replace(/&(?!(amp|lt|gt|quot|apos);)/g, '&amp;');
        const parsed = xmlParser.parse(sanitizedXml);
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


// ─── Build Puru conversation ──────────────────────────────────────────────────
async function buildConversation(userId) {
    const ws           = await ensureLoaded(userId);
    let   systemPrompt = `${ORCHESTRATOR_CONFIG.persona}\n\n${ORCHESTRATOR_CONFIG.tools}`;

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

// ─── Extract AI Text from various response formats ───────────────────────────
function extractAIText(data) {
    if (!data) return '';

    // 1. Handle JSON Object (Primary API format)
    if (typeof data === 'object') {
        if (data.result?.answer) return String(data.result.answer);
        if (data.answer)         return String(data.answer);
        if (data.text)           return String(data.text);
    }

    // 2. Handle SSE String (Fallback API format)
    if (typeof data === 'string' && data.includes('data:')) {
        try {
            const lines = data.split('\n');
            let fullText = '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:')) {
                    try {
                        const jsonStr = trimmed.replace(/^data:\s*/, '').trim();
                        if (jsonStr === '[DONE]') continue;
                        
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.text) fullText += parsed.text;
                    } catch (_) { /* Skip invalid JSON segments */ }
                }
            }
            if (fullText.trim()) return fullText.trim();
            
            // If we got "data:" lines but no text, maybe it's a different JSON structure
            console.warn('[extractAIText] SSE found but no text extracted. Raw sample:', data.slice(0, 100));
        } catch (e) {
            console.error('[extractAIText] SSE parse error:', e.message);
        }
    }

    // 3. Fallback: If it's a non-empty string that doesn't look like SSE, return it
    if (typeof data === 'string' && data.trim().length > 0) return data.trim();

    // 4. Last resort
    return typeof data === 'object' ? JSON.stringify(data) : String(data);
}

// ─── API call with alternating retry ─────────────────────────────────────────
async function callAIWithRetry(ctx, statusMsgId, payload) {
    if (global.AI_MOCK_RESPONSE) return global.AI_MOCK_RESPONSE();
    let lastError;
    
    for (let attempt = 1; attempt <= MAX_TOTAL_RETRIES; attempt++) {
        // Alternate: odd attempts use Primary, even attempts use Fallback
        const isPrimary = (attempt % 2 !== 0);
        const currentUrl = isPrimary ? AI_API_URL : FALLBACK_AI_API_URL;
        const apiName = isPrimary ? 'Gemini-V2 (Primary)' : 'Gemini (Fallback)';
        
        try {
            console.log(`[API] Attempt ${attempt}/${MAX_TOTAL_RETRIES} using ${apiName}...`);
            
            // Both APIs now use { prompt }
            const currentPayload = { prompt: payload.prompt };

            const response = await axios({
                method:  'post',
                url:     currentUrl,
                data:    currentPayload,
                headers: { 'Content-Type': 'application/json' },
                timeout: 60_000,
            });

            return response;
        } catch (err) {
            lastError = err;
            const errDesc = err.response?.data?.message || err.response?.data?.error || err.code || err.message || 'Unknown error';
            console.warn(`[API] ${apiName} failed (Attempt ${attempt}): ${errDesc}`);

            if (attempt < MAX_TOTAL_RETRIES) {
                const nextApi = (attempt % 2 === 0) ? 'Gemini-V2 (Primary)' : 'Gemini (Fallback)';
                const retryText = 
                    `⚠️ *API Error (${apiName}):*\n` +
                    `\`${errDesc}\`\n\n` +
                    `🔄 Percobaan ${attempt}/${MAX_TOTAL_RETRIES} gagal. Mencoba ${nextApi} dalam 3 detik...`;
                
                if (statusMsgId) {
                    try {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id, statusMsgId, null,
                            retryText, { parse_mode: 'Markdown' }
                        );
                    } catch (_) {}
                }
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    
    throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE SUB-AGENT RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

function formatCodeAgentResult(result) {
    if (typeof result === 'string') return result;

    const { status, executionSummary, modifiedFiles, finalMessage, technicalDetails } = result;
    
    let formatted = `Code Agent Result [Status: ${status}]\n`;
    formatted += `Summary: ${executionSummary}\n`;
    formatted += `Modified Files: ${modifiedFiles.length > 0 ? modifiedFiles.join(', ') : 'None'}\n`;
    formatted += `Message: ${finalMessage}\n`;
    if (technicalDetails) {
        formatted += `Details: ${technicalDetails}\n`;
    }

    // Smart Truncation: Prioritize Status, Summary, Modified Files.
    // If too long, truncate Message and Details.
    const LIMIT = 3000;
    if (formatted.length > LIMIT) {
        const header = `Code Agent Result [Status: ${status}]\nSummary: ${executionSummary}\nModified Files: ${modifiedFiles.length > 0 ? modifiedFiles.join(', ') : 'None'}\n`;
        const remaining = LIMIT - header.length;
        
        let body = `Message: ${finalMessage}\n`;
        if (technicalDetails) body += `Details: ${technicalDetails}\n`;
        
        if (body.length > remaining) {
            body = body.slice(0, remaining - 3) + '...';
        }
        formatted = header + body;
    }

    return formatted;
}

async function callCodeAgent(ctx, userId, subTask) {
    const ws = await ensureLoaded(userId);
    
    // Check if PLAN.md exists to provide a suggestion to the Code Agent
    try {
        const sandbox = await getSandbox(userId);
        await sandbox.files.read(resolveInSandbox(userId, 'PLAN.md'));
        subTask += "\n\n(Suggestion: Please read PLAN.md to understand the current plan and progress before proceeding.)";
    } catch (e) {
        // PLAN.md not found or sandbox error, proceed without suggestion
    }

    let conversation    = `System: ${CODE_AGENT_CONFIG.persona}\n\n${CODE_AGENT_CONFIG.tools}\n\nUser: ${subTask}`;
    let iteration       = 0;
    const interimMsgIds = [];

    const tracker = {
        modifiedFiles: new Set(),
        toolLogs: [],
        hasError: false,
        lastError: null,
        counts: {}
    };

    while (iteration < MAX_CODE_LOOPS) {
        if (ws.stopRequested) {
            if (ws.processing) {
                await ctx.reply('✅ Process stopped successfully');
                ws.processing = false;
            }
            break;
        }
        await ctx.sendChatAction('typing').catch(() => {});
        const typingHB = setInterval(() =>
            ctx.sendChatAction('typing').catch(() => {}), 4000);

        let rawText = '';
        try {
            const response = await callAIWithRetry(ctx, null,
                { prompt: conversation + '\nAssistant:' }
            );
            rawText = extractAIText(response.data);
        } catch (err) {
            clearInterval(typingHB);
            for (const id of interimMsgIds) {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) {}
            }
            return {
                status: 'error',
                finalMessage: `[Code Agent Error]: ${err.message}`,
                modifiedFiles: Array.from(tracker.modifiedFiles),
                executionSummary: 'Execution failed due to API error',
                technicalDetails: err.message
            };
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

            const status = tracker.hasError ? 'partial_success' : 'success';
            
            // Build summary
            const summaryParts = [];
            if (tracker.counts.read_file) summaryParts.push(`Membaca ${tracker.counts.read_file} file`);
            const modifiedCount = (tracker.counts.write_file || 0) + (tracker.counts.edit_file || 0);
            if (modifiedCount) summaryParts.push(`mengubah ${modifiedCount} file`);
            if (tracker.counts.bash) summaryParts.push(`menjalankan ${tracker.counts.bash} perintah bash`);
            if (tracker.counts.ls || tracker.counts.grep) summaryParts.push(`mencari ${ (tracker.counts.ls || 0) + (tracker.counts.grep || 0) } kali`);
            
            return {
                status,
                finalMessage: finalText || rawText,
                modifiedFiles: Array.from(tracker.modifiedFiles),
                executionSummary: summaryParts.join(', ') || 'Tidak ada tool yang digunakan',
                technicalDetails: tracker.lastError
            };
        }
        

        // Show Code Agent thinking (interim)
        if (message) {
            try {
                const sent = await ctx.reply(`${AGENT_LABELS.CODE.CHAT} ${message}`, { parse_mode: 'Markdown' });
                interimMsgIds.push(sent.message_id);
            } catch (_) {}
        }

        // Execute tool in E2B sandbox
        try {
            const { action, params } = toolCall;
            
            // Track tool usage
            tracker.toolLogs.push(`${action}: ${params.path || params.command || ''}`);
            tracker.counts[action] = (tracker.counts[action] || 0) + 1;
            if (action === 'write_file' || action === 'edit_file') {
                if (params.path) tracker.modifiedFiles.add(params.path);
            }

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
            tracker.hasError = true;
            tracker.lastError = e.message;
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

    const status = 'error';
    const finalMsg = ws.stopRequested ? '[Code Agent]: Process stopped by user.' : '[Code Agent]: Mencapai batas iterasi tool.';
    
    const summaryParts = [];
    if (tracker.counts.read_file) summaryParts.push(`Membaca ${tracker.counts.read_file} file`);
    const modifiedCount = (tracker.counts.write_file || 0) + (tracker.counts.edit_file || 0);
    if (modifiedCount) summaryParts.push(`mengubah ${modifiedCount} file`);
    if (tracker.counts.bash) summaryParts.push(`menjalankan ${tracker.counts.bash} perintah bash`);
    if (tracker.counts.ls || tracker.counts.grep) summaryParts.push(`mencari ${ (tracker.counts.ls || 0) + (tracker.counts.grep || 0) } kali`);

    return {
        status,
        finalMessage: finalMsg,
        modifiedFiles: Array.from(tracker.modifiedFiles),
        executionSummary: summaryParts.join(', ') || 'Tidak ada tool yang digunakan',
        technicalDetails: tracker.lastError
    };
}

async function callArchitectAgent(ctx, userId, subTask) {
    const ws = await ensureLoaded(userId);
    let conversation    = `System: ${ARCHITECT_CONFIG.persona}\n\n${ARCHITECT_CONFIG.tools}\n\nUser: ${subTask}`;
    let iteration       = 0;
    const interimMsgIds = [];

    const tracker = {
        modifiedFiles: new Set(),
        toolLogs: [],
        hasError: false,
        lastError: null,
        counts: {}
    };

    while (iteration < MAX_CODE_LOOPS) {
        if (ws.stopRequested) {
            if (ws.processing) {
                await ctx.reply('✅ Process stopped successfully');
                ws.processing = false;
            }
            break;
        }
        await ctx.sendChatAction('typing').catch(() => {});
        const typingHB = setInterval(() =>
            ctx.sendChatAction('typing').catch(() => {}), 4000);

        let rawText = '';
        try {
            const response = await callAIWithRetry(ctx, null,
                { prompt: conversation + '\nAssistant:' }
            );
            rawText = extractAIText(response.data);
        } catch (err) {
            clearInterval(typingHB);
            for (const id of interimMsgIds) {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) {}
            }
            return {
                status: 'error',
                finalMessage: `[Architect Agent Error]: ${err.message}`,
                modifiedFiles: Array.from(tracker.modifiedFiles),
                executionSummary: 'Execution failed due to API error',
                technicalDetails: err.message
            };
        } finally {
            clearInterval(typingHB);
        }

        const { message, toolCall } = parseCodeResponse(rawText);

        if (!toolCall) {
            const finalText = message || rawText
                .replace(/<response\s*>/gi,  '')
                .replace(/<\/response\s*>/gi, '')
                .replace(/<message\s*>([\s\S]*?)<\/message\s*>/gi, '$1')
                .trim();

            for (const id of interimMsgIds) {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) {}
            }

            const status = tracker.hasError ? 'partial_success' : 'success';
            
            const summaryParts = [];
            if (tracker.counts.read_file) summaryParts.push(`Membaca ${tracker.counts.read_file} file`);
            if (tracker.counts.write_file) summaryParts.push(`menulis ${tracker.counts.write_file} kali ke PLAN.md`);
            if (tracker.counts.ls || tracker.counts.grep) summaryParts.push(`mencari ${ (tracker.counts.ls || 0) + (tracker.counts.grep || 0) } kali`);
            
            return {
                status,
                finalMessage: finalText || rawText,
                modifiedFiles: Array.from(tracker.modifiedFiles),
                executionSummary: summaryParts.join(', ') || 'Tidak ada tool yang digunakan',
                technicalDetails: tracker.lastError
            };
        }

        if (message) {
            try {
                const sent = await ctx.reply(`${AGENT_LABELS.ARCHITECT.CHAT} ${message}`, { parse_mode: 'Markdown' });
                interimMsgIds.push(sent.message_id);
            } catch (_) {}
        }

        try {
            const { action, params } = toolCall;
            
            const allowedTools = ['ls', 'read_file', 'grep', 'write_file'];
            if (!allowedTools.includes(action)) {
                throw new Error(`Architect is not allowed to use tool: ${action}`);
            }

            if (action === 'write_file' && params.path !== 'PLAN.md') {
                throw new Error(`Architect can only write to PLAN.md. Attempted to write to: ${params.path}`);
            }

            tracker.toolLogs.push(`${action}: ${params.path || params.command || ''}`);
            tracker.counts[action] = (tracker.counts[action] || 0) + 1;
            if (action === 'write_file') {
                if (params.path) tracker.modifiedFiles.add(params.path);
            }

            const result = await Promise.resolve(tools[action](userId, params, ctx));

            try {
                const label   = `🛠️ ${action}`;
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
            tracker.hasError = true;
            tracker.lastError = e.message;
            try {
                const errMsg = await ctx.replyWithMarkdown(
                    `❌ *Architect Tool Error:* \`${toolCall.action || '?'}\`\n\`${e.message}\``
                );
                interimMsgIds.push(errMsg.message_id);
            } catch (_) {}
            conversation += `\nAssistant: ${rawText}\nTool Error: ${e.message}`;
        }
    }

    for (const id of interimMsgIds) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) {}
    }

    return {
        status: 'error',
        finalMessage: '[Architect Agent]: Mencapai batas iterasi tool.',
        modifiedFiles: Array.from(tracker.modifiedFiles),
        executionSummary: 'Reached iteration limit',
        technicalDetails: tracker.lastError
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PURU ORCHESTRATION LOOP
// ═══════════════════════════════════════════════════════════════════════════════
async function processPuruOrchestration(ctx, userId, statusMsgId, loopState = null) {
    const ws = await ensureLoaded(userId);
    // Capture the initial user request that triggered this orchestration
    const initialUserRequest = loopState?.initialRequest || 
        ([...ws.history].reverse().find(m => m.role === 'user')?.content || 'None');

    let puruConversation = loopState?.conversation || await buildConversation(userId);
    let puruIteration    = loopState?.iteration    || 0;
    const interimMsgIds  = [];

    while (puruIteration < MAX_PURU_LOOPS) {
        if (ws.stopRequested) {
            if (ws.processing) {
                await ctx.reply('✅ Process stopped successfully');
                ws.processing = false;
            }
            break;
        }
        await ctx.sendChatAction('typing').catch(() => {});
        const typingHB = setInterval(() =>
            ctx.sendChatAction('typing').catch(() => {}), 4000);

        let rawText = '';
        try {
            // Add a dynamic reminder to keep the AI focused on the goal
            const prompt = puruConversation + 
                `\n\n[SYSTEM REMINDER]\n- CURRENT GOAL: "${initialUserRequest}"\n- Stay focused on this goal. Do NOT make unrequested changes.\n- If the goal is met, provide the final answer.` +
                '\nAssistant:';

            const response = await callAIWithRetry(
                ctx,
                puruIteration === 0 ? statusMsgId : null,
                { prompt }
            );
            rawText = extractAIText(response.data);
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

        const { message, delegate, sendFile, lsCall } = parsePuruResponse(rawText);

        // Tool: send_file (directly from Puru)
        if (sendFile) {
            try {
                const result = await tools.send_file(userId, sendFile, ctx);
                await pushMessage(userId, 'output', `${AGENT_LABELS.PURU.LOG} send_file: ${result}`);
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

        // Tool: ls (directly from Puru)
        if (lsCall) {
            try {
                const result = await tools.ls(userId, lsCall);
                await pushMessage(userId, 'output', `${AGENT_LABELS.PURU.LOG} ls: ${result}`);
                puruConversation +=
                    `\nAssistant: <response><message>${message}</message>` +
                    `<ls><path>${lsCall.path}</path></ls></response>` +
                    `\nTool Result (ls): ${result}`;
                puruIteration++;
                continue;
            } catch (e) {
                console.error('[Puru ls Error]', e.message);
                puruConversation += `\nAssistant: <response><message>${message}</message></response>\nTool Error (ls): ${e.message}`;
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
                const sent = await ctx.reply(`${AGENT_LABELS.PURU.CHAT} ${message}`, { parse_mode: 'Markdown' });
                interimMsgIds.push(sent.message_id);
            } catch (_) {}
        }

        // Show delegation status (interim)
        try {
            const agentName = delegate.agent === 'Architect' ? 'Architect Agent' : 'Code Agent';
            const taskPreview = delegate.task.slice(0, 180);
            const delegateMsg = await ctx.reply(
                `⚙️ *Mendelegasikan ke ${agentName}...*\n_${taskPreview}${delegate.task.length > 180 ? '…' : ''}_`,
                { parse_mode: 'Markdown' }
            );
            interimMsgIds.push(delegateMsg.message_id);
        } catch (_) {}

        // Call appropriate agent
        const agentResult = delegate.agent === 'Architect'
            ? await callArchitectAgent(ctx, userId, delegate.task)
            : await callCodeAgent(ctx, userId, delegate.task);

        if (delegate.agent === 'Code') {
            try {
                const sandbox = await getSandbox(userId);
                await sandbox.files.remove(resolveInSandbox(userId, 'PLAN.md'));
                console.log(`[Orchestration] PLAN.md removed immediately after Code Agent finished for ${userId}`);
            } catch (e) {
                console.error('[Orchestration] Failed to remove PLAN.md after Code Agent:', e.message);
            }
        }

        // ── After each agent loop, persist workspace → Firebase ──────────
        await saveWorkspace(userId).catch(e =>
            console.error('[Orchestration] saveWorkspace error:', e.message)
        );

        // Push result to Puru's history
        const agentLabel = delegate.agent === 'Architect' ? AGENT_LABELS.ARCHITECT.LOG : AGENT_LABELS.CODE.LOG;
        const formattedResult = formatCodeAgentResult(agentResult);
        await pushMessage(userId, 'output',
            `${agentLabel} Result: ${formattedResult.slice(0, 600)}`
        );

        // Feed result back into Puru's active conversation
        const truncatedResult = formattedResult.length > 2000
            ? formattedResult.slice(0, 2000) + '... (truncated for context)'
            : formattedResult;

        const agentTag = delegate.agent === 'Architect' ? 'Architect' : 'Code';
        puruConversation +=
            `\nAssistant: <response><message>${message}</message>` +
            `<delegate agent="${agentTag}"><task>${delegate.task}</task></delegate></response>` +
            `\n${agentTag} Agent Result: ${truncatedResult}`;

        puruIteration++;
    }

    // ── Destroy user sandbox after loop ───────────────────────────
    await saveWorkspace(userId).catch(e =>
        console.error('[Orchestration] Final saveWorkspace error:', e.message)
    );

    await destroyUserSandbox(userId);

    if (ws.stopRequested) {
        return {
            type: 'stopped',
            interimMsgIds,
        };
    }

    return {
        type:         'error',
        text:         '⚠️ *Puru gagal menyelesaikan tugas.* Terlalu banyak loop (100 delegasi). Coba pecah permintaan kamu jadi lebih sederhana.',
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
    
    // Run document processing in the background (asynchronous)
    (async () => {
        ws.stopRequested = false;
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
    })();
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
    
    // Only block if it's an actual AI task request (Puru orchestration)
    // Non-task messages (like just 'hello' in group without prefix) are ignored anyway.
    // Commands are handled by other middlewares.
    if (ws.processing) {
        return ctx.reply('⏳ Tunggu respons sebelumnya selesai dulu ya! Atau ketik /stop untuk menghentikan paksa.');
    }

    // "continue" resumes a pending orchestration loop
    if (userMessage.trim().toLowerCase() === 'continue') {
        const state = pendingLoops.get(userId);
        if (state) {
            pendingLoops.delete(userId);
            ws.processing = true;
            
            // Run orchestration in the background (asynchronous)
            (async () => {
                ws.stopRequested = false;
                let statusMsg;
                try {
                    statusMsg = await ctx.reply('🔄 Melanjutkan orchestration... ⏳');
                    const result = await processPuruOrchestration(
                        ctx, userId, statusMsg.message_id, state
                    );
                    await handleAgentResult(ctx, userId, result, statusMsg.message_id);
                } catch (err) {
                    console.error('[Orchestration] Background continue error:', err);
                    try { await ctx.reply('❌ Terjadi kesalahan saat melanjutkan proses.'); } catch (_) {}
                } finally {
                    ws.processing = false;
                }
            })();
            return;
        }
    }

    // Normal message → Puru orchestration
    ws.processing = true;
    
    // Run orchestration in the background (asynchronous)
    (async () => {
        ws.stopRequested = false;
        let statusMsg;
        try {
            await pushMessage(userId, 'user', userMessage);
            statusMsg = await ctx.reply('🧠 Puru sedang berpikir... ⏳');
            const result = await processPuruOrchestration(ctx, userId, statusMsg.message_id);
            await handleAgentResult(ctx, userId, result, statusMsg.message_id);
        } catch (err) {
            console.error('[Orchestration] Background task error:', err);
            try { await ctx.reply('❌ Terjadi kesalahan saat memproses permintaan.'); } catch (_) {}
        } finally {
            ws.processing = false;
        }
    })();
});

// ─── Health-check HTTP server ─────────────────────────────────────────────────
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('✅ Puru Orchestrator v4.0 — Bot is running\n');
}).listen(PORT, () => {
    console.log(`🌐 Health-check server listening on port ${PORT}`);
});

// ─── Launch ───────────────────────────────────────────────────────────────────
(async () => {
    try {
        // Kill all ghost sandboxes before starting, unless in development mode
        if (env !== 'development') {
            await cleanupSandboxes();
        }

        await bot.telegram.setMyCommands([
            { command: 'start',   description: 'Mulai bot' },
            { command: 'menu',    description: 'Buka menu utama' },
            { command: 'info',    description: 'Status workspace & token' },
            { command: 'stop',    description: 'Hentikan proses aktif (paksa)' },
            { command: 'reset',   description: 'Reset workspace & history' },
            { command: 'help',    description: 'Bantuan' },
        ]);

        await bot.launch({
            polling: {
                allowedUpdates: ['message', 'callback_query'],
                timeout: 30, // seconds
            }
        });
        console.log('✅ Puru Orchestrator v4.0 running (E2B + Firebase)');
    } catch (e) {
        console.error('[FATAL] Failed to launch bot:', e);
        // Force exit on fatal launch failure to let process manager restart it
        process.exit(1);
    }
})();

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = async (signal) => {
    console.log(`[Shutdown] Received ${signal}. Closing bot...`);
    try {
        bot.stop(signal);
        console.log('👋 Bot stopped gracefully.');
        process.exit(0);
    } catch (e) {
        console.error('[Shutdown Error]', e.message);
        process.exit(1);
    }
};

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

module.exports = {
    processPuruOrchestration,
    parsePuruResponse,
    parseCodeResponse,
    callAIWithRetry
};
