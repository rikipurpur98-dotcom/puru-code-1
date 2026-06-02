'use strict';

/**
 * debug.js - Test suite for AI Orchestration
 * Run with: node debug.js
 */

// ─── 1. Mocking Setup ──────────────────────────────────────────────────────────

const callHistory = [];
const virtualFS = {};
const mockWorkspace = {
    history: [],
    processing: false,
    stopRequested: false,
    persona: null,
    loaded: true,
    messageCount: 0,
};

const mockCtx = {
    chat: { id: 12345 },
    from: { id: 12345 },
    reply: async (text, extra) => {
        callHistory.push({ type: 'reply', text });
        return { message_id: callHistory.length };
    },
    replyWithMarkdown: async (text, extra) => {
        callHistory.push({ type: 'replyWithMarkdown', text });
        return { message_id: callHistory.length };
    },
    sendChatAction: async (action) => {
        callHistory.push({ type: 'sendChatAction', action });
    },
    telegram: {
        editMessageText: async (chatId, msgId, text, extra) => {
            callHistory.push({ type: 'editMessageText', msgId, text });
        },
        deleteMessage: async (chatId, msgId) => {
            callHistory.push({ type: 'deleteMessage', msgId });
        }
    }
};

// Mock Tools Implementation
const mockTools = {
    ls: async (userId, params) => {
        const path = params.path || '.';
        const files = Object.keys(virtualFS).filter(f => f.startsWith(path.replace('./', '')));
        return files.length > 0 ? files.join('\n') : '(direktori kosong)';
    },
    read_file: async (userId, params) => {
        if (!params.path) throw new Error('Missing <path>');
        if (!virtualFS[params.path]) throw new Error(`File not found: ${params.path}`);
        return virtualFS[params.path];
    },
    write_file: async (userId, params) => {
        if (!params.path || params.content === undefined) throw new Error('Missing <path> or <content>');
        virtualFS[params.path] = params.content;
        return `File written: ${params.path} (${params.content.length} chars)`;
    },
    edit_file: async (userId, params) => {
        if (!params.path || !params.old_string || params.new_string === undefined) throw new Error('Missing params');
        let content = virtualFS[params.path];
        if (!content || !content.includes(params.old_string)) return 'Error: old_string not found in file.';
        virtualFS[params.path] = content.replace(params.old_string, params.new_string);
        return 'File edited successfully.';
    },
    grep: async (userId, params) => {
        if (!params.path || !params.pattern) throw new Error('Missing <path> or <pattern>');
        const content = virtualFS[params.path];
        if (!content) return 'No matches found.';
        return content.includes(params.pattern) ? 'Match found' : 'No matches found.';
    },
    bash: async (userId, params) => {
        if (!params.command) throw new Error('Missing <command>');
        return `Executed: ${params.command}\nOutput: Success`;
    },
    send_file: async (userId, params, ctx) => {
        if (!params.path) throw new Error('Missing <path>');
        if (!virtualFS[params.path]) throw new Error(`File not found: ${params.path}`);
        return `✅ File berhasil dikirim: ${params.path}`;
    }
};

// Override require.cache to inject mocks
const mockModules = {
    './lib/workspace': {
        ensureLoaded: async () => mockWorkspace,
        pushMessage: async () => {},
        getWorkspace: () => mockWorkspace,
    },
    './lib/sandbox': {
        saveWorkspace: async () => {},
        writeFileDirect: async () => {},
        cleanupSandboxes: async () => {},
        destroyUserSandbox: async () => {},
        getCachedStructure: () => 'PLAN.md\nbtc_price.py',
    },
    './lib/tools': mockTools,
};

// Mock Telegraf and HTTP to prevent bot/server from starting
const mockTelegraf = class {
    constructor() {}
    use() { return this; }
    catch() { return this; }
    start() { return this; }
    on() { return this; }
    command() { return this; }
    action() { return this; }
    launch() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
};
mockTelegraf.prototype.telegram = {
    setMyCommands: async () => {},
    editMessageText: async () => {},
    deleteMessage: async () => {},
    getFileLink: async () => ({ href: '' }),
};
mockTelegraf.Markup = { inlineKeyboard: () => ({}) };

const mockHttp = {
    createServer: () => ({
        on: () => {},
        listen: () => {},
    }),
};

const systemMocks = {
    'telegraf': mockTelegraf,
    'http': mockHttp,
};

// Inject system mocks
Object.entries(systemMocks).forEach(([name, mock]) => {
    try {
        const resolvedPath = require.resolve(name);
        require.cache[resolvedPath] = {
            id: resolvedPath,
            filename: resolvedPath,
            loaded: true,
            exports: name === 'telegraf' ? { Telegraf: mockTelegraf, Markup: mockTelegraf.Markup } : mock,
        };
    } catch (e) {
        // Module might not be installed in this environment, but it's needed for index.js
    }
});

Object.entries(mockModules).forEach(([path, mock]) => {
    const resolvedPath = require.resolve(path);
    require.cache[resolvedPath] = {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        exports: mock,
    };
});

// Now require the main logic
const { processPuruOrchestration } = require('./index');

// ─── 2. Test Runner ──────────────────────────────────────────────────────────

async function runTest(name, input, aiResponses, verifyFn, interruptAt = null) {
    console.log(`Running test: ${name}...`);
    
    // Reset state
    callHistory.length = 0;
    Object.keys(virtualFS).forEach(k => delete virtualFS[k]);
    mockWorkspace.history = [];
    mockWorkspace.stopRequested = false;
    mockWorkspace.processing = true;

    let responseIdx = 0;
    global.AI_MOCK_RESPONSE = () => {
        const resp = aiResponses[responseIdx++];
        return { data: resp };
    };

    // Handle interruption
    if (interruptAt !== null) {
        const originalCallAI = global.AI_MOCK_RESPONSE;
        global.AI_MOCK_RESPONSE = () => {
            if (responseIdx === interruptAt) {
                mockWorkspace.stopRequested = true;
            }
            return originalCallAI();
        };
    }

    try {
        // Simulate the flow in index.js
        // ensureLoaded is mocked in the module, not on the workspace object
        await mockModules['./lib/workspace'].ensureLoaded(12345);
        mockWorkspace.history.push({ role: 'user', content: input });
        
        const result = await processPuruOrchestration(mockCtx, 12345, 'status_id');
        
        const passed = await verifyFn(result);
        return { name, status: passed ? '✅ PASS' : '❌ FAIL' };
    } catch (e) {
        console.error(e);
        return { name, status: '❌ FAIL (Error)' };
    }
}

// ─── 3. Scenarios ────────────────────────────────────────────────────────────

async function main() {
    const results = [];

    // Scenario A: Simple
    results.push(await runTest(
        'Skenario A (Sederhana)',
        'Halo Puru',
        ['<response><message>Halo juga! Ada yang bisa saya bantu?</message></response>'],
        async (result) => {
            return result.type === 'final' && result.text.includes('Halo juga!');
        }
    ));

    // Scenario B: Complex
    results.push(await runTest(
        'Skenario B (Kompleks)',
        'Buatkan script Python untuk cek harga BTC',
        [
            // Puru delegates to Architect
            '<response><message>Saya akan buatkan script tersebut.</message><delegate agent="Architect"><task>Rancang script Python untuk cek harga BTC</task></delegate></response>',
            // Architect writes PLAN.md
            '<response><message>Rencana: Gunakan library requests.</message><tool><write_file><path>PLAN.md</path><content>1. Install requests\n2. Ambil data BTC</content></write_file></tool></response>',
            // Architect finishes
            '<response><message>Rencana selesai.</message></response>',
            // Puru delegates to Code
            '<response><message>Sekarang saya akan mengimplementasikannya.</message><delegate agent="Code"><task>Implementasikan rencana di PLAN.md</task></delegate></response>',
            // Code writes script
            '<response><message>Menulis script...</message><tool><write_file><path>btc_price.py</path><content>import requests\nprint("BTC Price")</content></write_file></tool></response>',
            // Code finishes
            '<response><message>Selesai.</message></response>',
            // Puru final answer
            '<response><message>Ini script Python untuk cek harga BTC.</message></response>'
        ],
        async (result) => {
            const planExists = !!virtualFS['PLAN.md'];
            const scriptExists = !!virtualFS['btc_price.py'];
            const finalAnswer = result.type === 'final' && result.text.includes('Ini script Python');
            return planExists && scriptExists && finalAnswer;
        }
    ));

    // Scenario C: Interruption
    results.push(await runTest(
        'Skenario C (Interupsi)',
        'Buatkan aplikasi toko',
        [
            '<response><message>Saya akan mulai...</message><delegate agent="Architect"><task>Rancang aplikasi toko</task></delegate></response>',
            '<response><message>Sedang merancang...</message><tool><write_file><path>PLAN.md</path><content>Toko App</content></write_file></tool></response>',
        ],
        async (result) => {
            return result.type === 'stopped' && callHistory.some(m => m.text === '✅ Process stopped successfully');
        },
        1 // Interrupt at the second AI response
    ));

    console.log('\n\n═══ TEST REPORT ═══');
    console.table(results);
}

main().catch(console.error);
