# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project overview

x-filter is an Avalonia UI (.NET 9) desktop app for detecting and blocking spam comments on X (Twitter). It connects to Chrome via CDP (Chrome DevTools Protocol) to scrape comments, uses a BERT ONNX model for spam classification, and automates blocking spam users.

## Development commands

```bash
cd XFilter
dotnet run --project src/XFilter.App     # Run the app
dotnet build                              # Build
dotnet publish -c Release -r win-x64 -o publish/win-x64  # Publish single-file exe (~27MB)
```

## Architecture

**XFilter.Core** — all business logic, zero UI dependency:
- `Cdp/CdpClient.cs` — WebSocket CDP client. Connect to `ws://{host}:{port}/devtools/browser`, send CDP commands with 10s timeout. Uses `ConcurrentDictionary<int, TaskCompletionSource>` for request/response matching. Provides `EvaluateAsync`, `ClickElementAsync`, `WaitForSelectorAsync`, `NavigatePageAsync`, `AttachToTargetAsync`, etc.
- `Cdp/CdpConstants.cs` — All X.com DOM selectors (`article[data-testid="tweet"]`, `[data-testid="caret"]`, etc.) and inline JS snippets for scraping/blocking.
- `Data/DatabaseService.cs` — SQLite via `Microsoft.Data.Sqlite` with raw ADO.NET. 6 tables: `comments`, `blocked_users`, `scrape_sessions`, `block_sessions`, `app_settings`, `blocklist`. Same schema as the original Electron app. DB stored at `%LOCALAPPDATA%/x-filter/data/x-filter.db`.
- `Services/ScraperService.cs` — Comment scraping via CDP evaluate calls. Implements TreeWalker-based text extraction for emoji support, "Discover more" boundary detection, dedup by normalized text, profile post URL extraction. Fires `ProgressChanged` events for UI.
- `Services/BlockerService.cs` — 3-step blocking flow: find article → click caret → click Block → confirm. 800ms delays between steps. Esc-key cleanup on failure.
- `Services/HfDownloader.cs` — Downloads models from HuggingFace Hub via `HttpClient`. Lists files from API, streams download with progress.
- `Services/ModelService.cs` — ONNX inference via `Microsoft.ML.OnnxRuntime`. Loads `onnx/model.onnx`, runs BERT with dual-segment input (post + comment concatenation).
- `Services/TrainingService.cs` — Orchestrates Python subprocess for training. Finds Python, checks CUDA, installs deps, runs `train.py`, parses `[STATUS]`/`[PROGRESS]`/`[METRICS]` output.
- `Tokenization/BertTokenizer.cs` — WordPiece tokenizer. Loads `vocab.txt`, implements basic tokenization + WordPiece subword splitting.
- `Tokenization/EmojiHelper.cs` — Strips emoji/Unicode symbols from text for BERT tokenization.
- `I18n/I18nService.cs` — Loads JSON translation files from `Resources/I18n/`. Supports `{{variable}}` template interpolation.

**XFilter.UI** — Avalonia MVVM layer:
- `ViewModels/MainViewModel.cs` — App shell. Manages sidebar navigation (9 views), role toggle (admin/user), connection status, model info. Uses `ContentControl` with `DataTemplate` for view switching (SPA-like behavior).
- `ViewModels/ConnectViewModel.cs` — Chrome connection: host/port inputs, connect/disconnect commands.
- `ViewModels/BlockViewModel.cs` — Main user flow: paste URL, scan & block. Orchestrates scrape → predict → block pipeline.
- `Views/MainWindow.axaml` — Sidebar (220px) + content area. Dark theme (#0f1923/#111827 background).

**XFilter.App** — Entry point:
- `Program.cs` — Avalonia app builder with platform detection.
- `App.axaml.cs` — DI composition root via `ServiceCollection`. Registers all services and view models. Shows `MainWindow`.

**Python scripts** (at repo root):
- `train.py` — Fine-tunes `bert-base-multilingual-cased` with HuggingFace Transformers. Input format: `[POST] post_text [COMMENT] comment_text`. Exports ONNX to `<output>/onnx/`.

## Key technical details

- Chrome remote debugging must be enabled: `chrome://inspect/#remote-debugging` → toggle "Allow remote debugging"
- Comments are deduplicated by SHA-256 hash of the text content
- CDP uses raw `System.Net.WebSockets.ClientWebSocket` (not puppeteer/playwright)
- The ONNX model expects input names: `input_ids`, `attention_mask`, `token_type_ids`
- Model output is a 2-class logit tensor; softmax is applied in C# for spam probability
- Dual-segment input: `[CLS] post_text [SEP] comment_text [SEP]`
- Blocking flow uses the same CDP session for efficiency; 2s delay between blocks
