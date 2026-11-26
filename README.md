# AI Chat for Zotero

A Zotero 10 plugin that lets you chat with an AI about the paper you're reading. It adds an **AI Chat** section to the item pane, in the library and next to open PDFs. The model sees the paper's metadata, full text and your highlights.

Works with Claude, OpenRouter, Requesty, and any OpenAI-compatible API (OpenAI, Ollama, LM Studio).

## Install

1. Download the latest `.xpi` from [Releases](https://github.com/Suresh-inbit/zotero-ai-chat/releases).
2. In Zotero: **Tools → Plugins** → gear icon → **Install Plugin From File…**
3. Open **Settings → AI Chat**, choose a service, paste your API key, and click **Test connection**.

The plugin updates itself after that.

## Features

- Ask questions about the selected paper, with suggested questions to start.
- Attach figures: crop part of the PDF, or paste a screenshot with **Ctrl+V**.
- LaTeX maths is shown as formatted equations.
- Chats are saved per paper and come back later. Open earlier ones from the chat's title.
- Save an answer, or the whole chat, as a Zotero note.
- Switch models from the menu next to the send button.

Chats are stored on your computer in the `ai-chat` folder of your Zotero data directory and are not synced. API keys stay in Zotero's settings and are sent only to the service you choose.

## Development

`src/` is the plugin. `./build.sh` packages it into `build/`.

```sh
cd tests && npm install && npm test   # unit tests
tests/run_integration.sh              # end-to-end test in a throwaway Zotero profile
```

Other test scripts in `tests/` cover dark mode, upgrades and reinstalling without a restart.

Maths is drawn by [KaTeX](https://katex.org) (MIT licence).
