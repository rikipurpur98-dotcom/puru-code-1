# GEMINI.md - Puru Orchestrator v4.0 (Shared Sandbox Edition)

Foundational context and operational instructions for Gemini CLI in this workspace.

## Project Overview
**Puru Orchestrator v4.0** is a sophisticated dual-agent Telegram bot designed for code execution and task orchestration. It employs a "Manager-Worker" architecture to handle user requests through autonomous planning and execution.

### Architecture & Key Technologies
- **Orchestrator (Puru):** The single point of contact for users. Responsible for breaking down complex requests into sub-tasks.
- **Sub-Agent (Code):** A stateless specialist that executes specific sub-tasks within a cloud sandbox.
- **Telegraf:** The Telegram Bot API framework for Node.js.
- **Shared E2B Sandbox:** Secure, cloud-hosted Linux Ubuntu sandbox where all users operate concurrently.
- **Firebase Realtime Database:** Used for persistent storage of user history, personas, and a shared workspace filesystem.
- **gpt-tokenizer:** Used for history compaction (3k limit) and token management.

## Environment & Configuration
Tokens and environment settings are managed through `config.json`. **Do NOT use .env files.**

### config.json Structure
```json
{
  "development": { "BOT_TOKEN": "..." },
  "production": { "BOT_TOKEN": "..." }
}
```

## Building and Running
The project uses standard `npm` scripts for execution.

- **Start Production:** `npm start` (Sets `NODE_ENV=production`)
- **Start Development:** `npm run dev` (Sets `NODE_ENV=development`)
- **Install Dependencies:** `npm install`
- **Share Project:** `npm run share` (Creates a temporary ZIP and download server)

## Core Logic & Workflows

### Command Prefixes (Group Chats)
In group or supergroup chats, the bot responds only to messages starting with:
- `/ai`
- `!ai`
- `.ai`
The prefix is automatically stripped before the message is sent to the Orchestrator. In private chats, all text messages are processed.

### Orchestration Loop
1. **User Message:** Received via Telegram.
2. **Puru Planning:** Puru generates an XML response containing a `<delegate>` task.
3. **API Call with Alternating Retry:** 
   - Attempt 1: Gemini-V2 (Primary)
   - Attempt 2: Gemini (Fallback)
   - Continues alternating up to 5 total attempts.
4. **Code Execution:** The task is sent to the Code Agent, which executes tools in the shared E2B sandbox.
5. **Tool Result:** Fed back to Puru.
6. **Iteration:** The loop continues (up to 10 times) until Puru provides a final `<response>`.
7. **State Persistence:** After each loop, shared workspace files are synced to Firebase if changes are detected.

### Sandbox & Workspace Lifecycle
- **Shared Environment:** All users share the same E2B sandbox instance and filesystem.
- **Auto-Versioning:** The workspace uses a `version.txt` file containing an MD5 hash of the Firebase state.
- **Sync on Awake:** When the sandbox is accessed, it compares its local version with Firebase and auto-synchronizes if a mismatch is detected.
- **Optimized Persistence:** Workspace saves to Firebase are skipped if the version hash remains unchanged.
- **Startup Cleanup:** On bot launch, all existing/leaked sandboxes are identified and killed to ensure a clean state.
- **Removal Policy:** Sandboxes are totally killed (not paused) after 5 minutes of inactivity.

## Development Conventions
- **Token Management:** Token counting using `gpt-tokenizer`, auto-compacting at 3,000 tokens. Logic in `lib/workspace.js`.
- **API Resilience:** Dual-API fallback system (Gemini-V2 Primary / Gemini Fallback) with alternating retries.
- **Response Handling:** Robust parsing for both standard JSON and SSE (streaming) responses in `index.js`.
- **Tool Logic:** Core agent tools (ls, read_file, etc.) are located in `lib/tools.js`.
- **Sandbox Management:** Shared E2B lifecycle, versioning, and sync logic are in `lib/sandbox.js`.
- **Workspace State:** User-specific history and token management are in `lib/workspace.js`.
- **Plugins:** Command handlers and interactive menus are modularized in the `plugins/` directory.
- **Response Format:** Both agents communicate using specific XML structures (`<response>`, `<message>`, `<delegate>`, `<tool>`).

## Key Files
- `index.js`: Main entry point, alternating API retry/fallback logic, and bot initialization.
- `package.json`: Project dependencies and scripts.
- `config.json`: Environment-specific API tokens.
- `lib/firebase.js`: Firebase RTDB integration (Personal history: `users/{id}`, Shared files: `users/shared_workspace`).
- `lib/sandbox.js`: Shared E2B Sandbox management (versioning, cleanup, sync).
- `lib/tools.js`: Tool definitions for the Code Agent.
- `lib/workspace.js`: Personal token counting and history management (3k limit).
- `plugins/menu.js`: Implementation of `/menu`, `/info`, `/reset` (personal), and `/help`.
- `share.js`: Utility for project archival and sharing.
