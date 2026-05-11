# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

x-filter is an Electron app for detecting and blocking spam comments on X (Twitter). It connects to Chrome via CDP (Chrome DevTools Protocol) to scrape comments, uses a fine-tuned BERT model for spam classification, and automates blocking spam users.

## Development commands

```bash
npm run dev      # Start Vite dev server + Electron (auto-reloads on changes)
npm run build    # Vite build + electron-builder package
npm run start    # Run Electron directly (no Vite, uses dist/index.html)
npm run preview  # Vite preview only
```

## Architecture

**Electron main process** (`main.js`, `src/main/`):
- `main.js` — Entry point. Creates BrowserWindow, loads from Vite in dev or `dist/` in prod. Calls `initDatabase()` then `registerIpcHandlers()` on ready.
- `cdp-manager.js` — WebSocket client that speaks CDP to Chrome's remote debugging port (default `127.0.0.1:9222`). Exposes `connect()`, `evaluate()`, `navigatePage()`, `openNewTab()`, etc. All CDP commands get a 10s timeout.
- `database.js` — SQLite via `sql.js`. Stores comments (`comments` table — fields include `text`, `post_text`, `username`, `source_url`, deduped by SHA-256 on `text`), blocked users, scrape/block sessions, and app settings. Saves to `userData/x-filter.db`.
- `model-manager.js` — Loads an ONNX BERT model via `@xenova/transformers`. `predict()` returns `{spam, confidence}`. The model expects LABEL_1 = spam.
- `x-scraper.js` — Scrapes comments from an X post URL. Opens/navigates Chrome tab, scrolls to load replies, extracts text + username from `article[data-testid="tweet"]` elements. Deduplicates by text content.
- `x-blocker.js` — Automates blocking users. Navigates to the post, finds the commenter's `article`, clicks the "..." caret menu, clicks "Block", confirms dialog. Records blocked users in DB.
- `ipc-handlers.js` — All `ipcMain.handle()` registrations: CDP connect/disconnect, scrape, labels CRUD, export CSV, model load/predict, block start/cancel/all, train env/install/start/cancel, Python download, settings get/set.

**Renderer** (`src/renderer/`):
- `app.js` — SPA router. Maps view names to modules in `views/` via dynamic `import()`. Two roles: admin (full access: collect → label → export → train) and user (block only).
- `ui.js` — Shared utilities: `showStatus()`, `el()` (DOM builder), `apiInvoke()` (IPC wrapper), `updateSidebarStatus()`.
- `views/connection.js` — Chrome connection view. Host/port inputs, connect/disconnect buttons.
- `views/admin-collect.js` — Paste X post URL, scrape comments into DB.
- `views/admin-label.js` — Label comments as spam/not-spam with keyboard shortcuts (S/N/arrow keys).
- `views/admin-export.js` — Export labeled data to CSV for training.
- `views/admin-train.js` — In-app training: checks Python env, installs deps, runs `train.py`, loads trained model.
- `views/admin-settings.js` — Configure scroll params, spam threshold, show model info.
- `views/user-block.js` — Paste post URL, model predicts spam, auto-blocks spam users. Has "Scan & Block" (model-filtered) and "Block All" (no filter).

**Preload** (`preload.js`): Exposes `window.api.invoke()` and `window.api.on()` via `contextBridge` (though `nodeIntegration: true` is also set, so `require('electron')` works directly in renderer).

**Python training** (`train.py`):
- CLI script: `python train.py --csv data/labeled.csv --output data/models/x-spam-classifier`
- Fine-tunes `bert-base-multilingual-cased` with HuggingFace Transformers + Optimum ONNX export.
- Outputs structured progress lines (`[STATUS]`, `[PROGRESS]`, `[METRICS]`) parsed by Electron for UI display.
- Uses early stopping (patience=2) with F1 as best model metric.
- Exports ONNX model to `<output>/onnx/` for inference by `@xenova/transformers`.

## Data flow

1. **Collect**: Admin pastes X post URL → CDP scrapes comments + original post text → stored in SQLite (deduped by text hash, each comment linked to `post_text`)
2. **Label**: Admin marks comments as spam (label=1) or not-spam (label=0). Original post text is shown alongside each comment so admins can judge relevance.
3. **Export**: Labeled data exported as CSV (text, post_text, label columns)
4. **Train**: `train.py` fine-tunes BERT with concatenated `[POST] <post> [COMMENT] <comment>` format. Exports ONNX model to `<userData>/models/x-spam-classifier/onnx/`.
5. **Block**: User pastes post URL → scrape comments + post text → model predicts spam (using post-comment relevance) → CDP automates blocking

The core spam signal is **relevance**: a comment unrelated to the original post is likely spam. Both training and inference concatenate post and comment text so the BERT model can learn this relationship.

## Key technical details

- Chrome remote debugging must be enabled: `chrome://inspect/#remote-debugging` → toggle "Allow remote debugging"
- Comments are deduplicated by SHA-256 hash of the text content before insertion
- The app has a portable Python download feature (Windows only) that fetches embeddable Python 3.12.7
- CDP uses raw WebSocket (not puppeteer/playwright) — all DOM interaction is via `Runtime.evaluate` with inline JS
- `nodeIntegration: true` and `contextIsolation: false` — renderer can `require('electron')` directly
