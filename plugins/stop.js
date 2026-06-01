'use strict';
const { ensureLoaded } = require('../lib/workspace');

module.exports = (bot) => {
    // ─── /stop ────────────────────────────────────────────────────────────────
    bot.command('stop', async (ctx) => {
        const userId = ctx.from.id;
        const ws     = await ensureLoaded(userId);

        if (!ws.processing) {
            return ctx.reply('🛑 *Tidak ada proses aktif* yang sedang berjalan untuk akun kamu.', { parse_mode: 'Markdown' });
        }

        ws.stopRequested = true;
    });
};
