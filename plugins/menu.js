'use strict';
const { Markup }       = require('telegraf');
const {
    getWorkspace,
    ensureLoaded,
    getTotalTokens,
    clearWorkspace,
    HISTORY_TOKEN_LIMIT,
    GLOBAL_TOKEN_LIMIT,
} = require('../lib/workspace');

const { saveHistory, deleteWorkspace: deleteFirebaseWorkspace } = require('../lib/firebase');
const { resetUser, sharedSandboxEntry }                          = require('../lib/sandbox');

module.exports = (bot) => {

    // ─── /menu ────────────────────────────────────────────────────────────────
    bot.command('menu', async (ctx) => {
        await ctx.reply(
            `📜 *Main Menu*\n\nBerikut command yang tersedia:\n` +
            `/start   — Mulai\n` +
            `/menu    — Buka Menu\n` +
            `/info    — Status Workspace\n` +
            `/persona — Set persona AI\n` +
            `/reset   — Reset Workspace\n` +
            `/help    — Bantuan`,
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

    // ─── /info ────────────────────────────────────────────────────────────────
    const handleInfo = async (ctx) => {
        const userId      = ctx.from.id;
        const ws          = await ensureLoaded(userId);
        const totalTokens = getTotalTokens(userId);
        const sandboxActive = !!sharedSandboxEntry;
        const personaLine = ws.persona
            ? `\n🎭 *Persona:* \`${ws.persona.slice(0, 80)}${ws.persona.length > 80 ? '…' : ''}\``
            : '';

        await ctx.replyWithMarkdown(
            `🏢 *Workspace Status — Puru v4.0*\n` +
            `──────────────────\n` +
            `👤 *User ID:* \`${userId}\`\n` +
            `📅 *Created:* \`${ws.createdAt}\`\n` +
            `💬 *Total Messages:* ${ws.messageCount}\n` +
            `📦 *History:* ${ws.history.length} pesan\n` +
            `🧠 *Puru Tokens:* \`${totalTokens}\` / \`${HISTORY_TOKEN_LIMIT}\` (5k limit)\n` +
            `🌐 *Global Limit:* \`${GLOBAL_TOKEN_LIMIT}\` token\n` +
            `🔧 *Code Agent:* Stateless (Shared E2B sandbox)\n` +
            `🧪 *E2B Sandbox:* ${sandboxActive ? '✅ Aktif (Shared)' : '⏸️ Tidak aktif'}\n` +
            `☁️ *Storage:* Firebase RTDB (Shared Files, Personal History)` +
            personaLine +
            `\n──────────────────`
        );
    };

    bot.command('info', handleInfo);
    bot.action('menu_info', async (ctx) => {
        await handleInfo(ctx);
        try { await ctx.answerCbQuery(); } catch (_) {}
    });

    // ─── /reset ───────────────────────────────────────────────────────────────
    const handleReset = async (ctx) => {
        const userId = ctx.from.id;

        // 1. Reset user (history only, shared filesystem preserved)
        await resetUser(userId);

        // 2. Clear in-memory workspace cache
        clearWorkspace(userId);

        // 3. Clear lock if stuck
        const ws = ensureLoaded(userId);
        if (ws.then) {
            ws.then(w => w.processing = false);
        } else {
            ws.processing = false;
        }

        await ctx.reply(
            '♻️ *Workspace di-reset!*\n\nHistory dan persona kamu dihapus dari Firebase.\n' +
            '_Catatan: File di shared sandbox tetap ada untuk semua user._',
            { parse_mode: 'Markdown' }
        );
    };

    bot.command('reset', handleReset);
    bot.action('menu_reset', async (ctx) => {
        await handleReset(ctx);
        try { await ctx.answerCbQuery(); } catch (_) {}
    });

    // ─── /help ────────────────────────────────────────────────────────────────
    const handleHelp = async (ctx) => {
        await ctx.reply(
            `ℹ️ *Bantuan Puru Orchestrator v4.0*\n\n` +
            `Kirim pesan biasa untuk chat dengan Puru (Orchestrator).\n\n` +
            `*Arsitektur v4:*\n` +
            `🧠 Puru — Orchestrator, single point of contact\n` +
            `🔧 Code — Sub-agent stateless, eksekusi di Shared E2B Sandbox\n` +
            `☁️ Firebase — Penyimpanan history (personal) & file (shared)\n` +
            `🧪 E2B — Shared cloud sandbox (Linux, internet-enabled)\n\n` +
            `*Alur Kerja:*\n` +
            `1. User kirim pesan → Puru terima\n` +
            `2. Puru buat rencana & pecah jadi sub-task kecil\n` +
            `3. Puru delegasikan ke Code Agent (satu per satu)\n` +
            `4. Code Agent: jalankan tools di Shared E2B sandbox\n` +
            `5. Setelah loop selesai: shared workspace di-save ke Firebase\n\n` +
            `*Commands:*\n` +
            `/start            — Mulai bot\n` +
            `/menu             — Buka menu\n` +
            `/info             — Status & token usage\n` +
            `/persona <teks>   — Set persona AI (tersimpan)\n` +
            `/persona reset    — Hapus persona\n` +
            `/reset            — Reset history & persona (file shared tetap ada)\n` +
            `/help             — Bantuan ini\n\n` +
            `*Storage & Sandbox:*\n` +
            `• Puru history: max 5.000 token (personal, auto-compact)\n` +
            `• Code Agent: stateless, shared filesystem antar user\n` +
            `• E2B sandbox: keep-alive 5 menit (shared)\n` +
            `• Workspace files: tersimpan di Firebase (shared), di-inject ke sandbox baru\n` +
            `• Ketik *"continue"* jika Puru mencapai batas 10 siklus`,
            { parse_mode: 'Markdown' }
        );
    };

    bot.command('help', handleHelp);
    bot.action('menu_help', async (ctx) => {
        await handleHelp(ctx);
        try { await ctx.answerCbQuery(); } catch (_) {}
    });

    // ─── /persona ─────────────────────────────────────────────────────────────
    bot.command('persona', async (ctx) => {
        const userId = ctx.from.id;
        const ws     = await ensureLoaded(userId);
        const text   = ctx.message.text.replace(/^\/persona\s*/i, '').trim();

        if (!text) {
            const current = ws.persona
                ? `🎭 *Persona aktif:*\n\`${ws.persona}\`\n\n` +
                  `Gunakan \`/persona <teks>\` untuk mengubah, atau \`/persona reset\` untuk menghapus.`
                : `ℹ️ Belum ada persona. Gunakan:\n\`/persona <deskripsi gaya AI kamu>\`\n\n` +
                  `*Contoh:*\n\`/persona Kamu adalah senior dev sarkastik yang suka roasting code jelek\``;
            return ctx.replyWithMarkdown(current);
        }

        if (text.toLowerCase() === 'reset') {
            ws.persona = null;
            await saveHistory(userId, ws);
            return ctx.reply('🗑️ Persona dihapus dan disimpan ke Firebase. AI kembali ke mode default.');
        }

        ws.persona = text;
        await saveHistory(userId, ws);
        await ctx.replyWithMarkdown(
            `✅ *Persona berhasil di-set dan disimpan ke Firebase!*\n\n` +
            `🎭 \`${text}\`\n\n` +
            `_Persona ini aktif untuk semua pesan berikutnya dan tetap ada setelah bot restart._`
        );
    });
};
