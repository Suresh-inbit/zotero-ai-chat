# AI Chat for Zotero

A Zotero 10 plugin that adds an **AI Chat** section to the item pane. Select a paper (or open its PDF) and ask questions about it. The plugin sends the item's metadata, the attachment's full text and your highlights and comments to the model along with your question.

Works with:

- **Claude** (Anthropic API). Default model `claude-opus-5-5`.
- **Any OpenAI-compatible API**: OpenAI, OpenRouter, Requesty, a local Ollama or LM Studio server, and so on.

## Install

1. Build the plugin (or use the prebuilt file in `build/`):
   ```sh
   ./build.sh          # creates build/zotero-ai-chat-1.0.0.xpi
   ```
2. In Zotero: **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…**, and pick the `.xpi`.
3. Open **Edit → Settings → AI Chat** (on macOS, **Zotero → Settings**) and set up a provider:
   - **Claude**: paste an API key from <https://platform.claude.com>. Keep the default model or pick another one.
   - **OpenAI-compatible**: set the base URL, API key and model name. Examples:

     | Service | Base URL | Model example |
     |---|---|---|
     | OpenAI | `https://api.openai.com/v1` | as listed in your account |
     | OpenRouter | `https://openrouter.ai/api/v1` | `vendor/model` |
     | Requesty | `https://router.requesty.ai/v1` | `vendor/model` |
     | Ollama (local) | `http://localhost:11434/v1` | `llama3.1`, leave the key empty |

     A full `…/chat/completions` URL also works.
4. Click **Test connection**.

## Use

- Select an item in your library, or open a PDF. Scroll the right-hand pane to **AI Chat**, or click its chat icon in the pane's side bar.
- Type a question and press **Enter** (use **Shift+Enter** for a new line), or click one of the suggested questions.
- **Stop** cancels an answer while it is being written.
- **Copy** copies an answer as Markdown. **Save as note** saves the question and answer as a child note of the item. **Save chat** saves the whole conversation.
- **New chat** starts over, and re-reads the item, so it picks up new annotations.
- Each item has its own conversation. The library and the PDF reader share it. Conversations last until Zotero quits; save the useful ones as notes.

### What is sent to the model

- Metadata: title, authors, date, publication, DOI, URL and abstract.
- Full text of the open PDF (in the reader) or the item's best attachment (in the library). Zotero must be able to extract text, so scanned PDFs without OCR only give metadata.
- Your highlights and comments on that attachment. You can turn this off in settings.
- Text beyond **Maximum characters of full text** (default 200,000, about 50,000 tokens) is cut off. The chat tells you when that happens.

With Claude, the document is sent with prompt caching, so follow-up questions about the same paper are cheaper and faster.

## Settings

All settings are under **Settings → AI Chat**.

| Setting | Default | Notes |
|---|---|---|
| Service | Claude | Claude or OpenAI-compatible |
| Claude model | `claude-opus-5-5` | `claude-sonnet-5-5` is faster and cheaper; `claude-haiku-5-5` is the fastest and cheapest |
| Effort | Medium | How much Claude thinks before answering |
| Maximum characters | 200,000 | How much full text to send |
| Include highlights and comments | on | |
| Extra instructions | empty | Added to the system prompt, e.g. "Answer in German" |

API keys are stored in Zotero's preferences (`prefs.js` in your Zotero profile) on your computer, like other Zotero plugins do. They are only sent to the API URL you configure.

## Development

```
src/                 the plugin (this folder is what gets zipped)
  manifest.json
  bootstrap.js       lifecycle hooks
  prefs.js           default settings
  content/aichat.js  chat UI, API clients, Markdown renderer, note saving
  content/aichat.css
  content/preferences.xhtml / preferences.js   settings pane
  locale/en-US/zotero-ai-chat.ftl
tests/
  unit.test.js       Node tests: stream parsing, API clients, chat flow, Markdown
  run_integration.sh end-to-end test in a throwaway Zotero profile
  harness/           test plugin that drives the UI during the end-to-end test
  mock_server.py     fake Claude/OpenAI API used by the end-to-end test
  make_test_pdf.py
```

Run the tests:

```sh
cd tests && npm install && npm test      # unit tests
tests/run_integration.sh                 # end-to-end, headless; never touches your real library
XPI=build/zotero-ai-chat-1.0.0.xpi tests/run_integration.sh   # test the packaged file
```

The end-to-end test starts a second Zotero with its own temporary profile and data folder, loads the plugin, and checks the chat UI in the library and the reader, request contents, note saving, error handling, Stop, the settings pane, and disabling and re-enabling the plugin. It saves screenshots in the work directory's `out/` folder.

To develop against your own Zotero without rebuilding, use a proxy file. Quit Zotero, create a text file named `zotero-ai-chat@suresh-inbit` in your profile's `extensions` folder that contains the absolute path to `src`, then start Zotero.

### Updates

`manifest.json` points `update_url` at `update.json` in a GitHub repository `Suresh-inbit/zotero-ai-chat`. If you publish the plugin there, list new versions in `update.json` so Zotero can update automatically. Until then, the update check finds nothing, which is harmless.
