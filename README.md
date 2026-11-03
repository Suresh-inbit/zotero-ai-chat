# AI Chat for Zotero

A Zotero 10 plugin that adds an **AI Chat** section to the item pane. Select a paper (or open its PDF) and ask questions about it. The plugin sends the item's metadata, the attachment's full text and your highlights and comments to the model along with your question.

Works with:

- **Claude** (Anthropic API). Default model `claude-opus-5-5`.
- **OpenRouter** and **Requesty**: pick them from the service menu. Their base URLs are filled in; paste your key.
- **Any other OpenAI-compatible API**: OpenAI, a local Ollama or LM Studio server, and so on, using the "OpenAI-compatible API" option.

## Install

1. Build the plugin (or use the prebuilt file in `build/`):
   ```sh
   ./build.sh          # creates build/zotero-ai-chat-1.3.0.xpi
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
- Type a question and press **Enter** (use **Shift+Enter** for a new line), or click one of the suggested questions. The arrow button sends; while an answer is being written it becomes a stop button.
- The model menu next to the send button lists your favorite models (see below) and the current model.
- **Images:** click the crop button (left, under the text box), then drag a box over a figure, table or equation, on the PDF or anywhere in the Zotero window (Esc cancels). Zoom the PDF in first for a sharper image. You can also copy an image (a screenshot tool, a browser, or Zotero's "Copy Image") and press **Ctrl+V** in the text box (**Cmd+V** on macOS), or click the picture button next to the crop button. Attached images show as thumbnails (the × removes one) and are sent with your next question, up to 8 at a time. They stay part of the conversation for follow-up questions. Use a model that supports images; if it doesn't, the error is shown and your images go back to the text box.
- Under each answer: copy it as Markdown, or save the question and answer as a child note of the item. The note button at the top saves the whole chat. If a question fails, **Retry** asks it again.
- **Maths:** LaTeX in answers is shown as formatted equations: `\( … \)` and `$ … $` inline, and `\[ … \]`, `$$ … $$` and `\begin{align}` (also `equation`, `gather`, `alignat`) as displayed equations. Prices such as "$5 and $10" stay text. A formula that isn't valid LaTeX is shown as written, underlined; hover over it to see why. Wide equations scroll sideways. Selecting and copying text gives each formula as its LaTeX (`$…$`). Saved notes keep the equations, and Zotero's note editor shows them formatted.
- **Chat history:** each item keeps its chats. The title at the top of the chat (with the clock icon) opens the list of earlier chats about the item; click one to continue it, or use the bin icon to delete it (click twice). **+** starts a new chat and keeps the current one in the list. When you come back to an item, even after restarting Zotero, its last chat is shown again. The library and the PDF reader share the same chats.
- Opening or starting a chat re-reads the item, so it picks up new annotations.

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
| Favorite models | Claude: opus, sonnet and haiku 5.5 | One model per line (commas also work). They fill the chat's model menu. Empty by default for OpenAI-compatible services |
| Claude model | `claude-opus-5-5` | `claude-sonnet-5-5` is faster and cheaper; `claude-haiku-5-5` is the fastest and cheapest |
| Effort | Medium | How much Claude thinks before answering |
| Maximum characters | 200,000 | How much full text to send |
| Include highlights and comments | on | |
| Extra instructions | empty | Added to the system prompt, e.g. "Answer in German" |
| Save chats | on | Keeps chat history; **Delete all chat history** clears it |

To fill in the list from the server, click **Load models from server** in the Settings. Pick a model from the list to use it; it is also added to your favorites.

Chats are saved as one JSON file per item in the `ai-chat` folder of your Zotero data directory (the folder with `zotero.sqlite`), including any images you sent. They stay on your computer and are not synced. Up to 50 chats are kept per item. Emptying an item from the trash deletes its chats.

API keys are stored in Zotero's preferences (`prefs.js` in your Zotero profile) on your computer, like other Zotero plugins do. They are only sent to the API URL you configure.

## Development

```
src/                 the plugin (this folder is what gets zipped)
  manifest.json
  bootstrap.js       lifecycle hooks
  prefs.js           default settings
  content/aichat.js  chat UI, API clients, chat history, Markdown and maths rendering, note saving
  content/aichat.css
  content/katex/     KaTeX 0.19.0 (MIT licence), which draws the maths
  content/preferences.xhtml / preferences.js   settings pane
  locale/en-US/zotero-ai-chat.ftl
tests/
  unit.test.js       Node tests: stream parsing, API clients, chat flow, history, Markdown, maths
  run_integration.sh end-to-end test in a throwaway Zotero profile
  harness/           test plugin that drives the UI during the end-to-end test
  mock_server.py     fake Claude/OpenAI API used by the end-to-end test
  make_test_pdf.py
```

Run the tests:

```sh
cd tests && npm install && npm test      # unit tests
tests/run_integration.sh                 # end-to-end, headless; never touches your real library
XPI=build/zotero-ai-chat-1.3.0.xpi tests/run_integration.sh   # test the packaged file
DARK=1 tests/run_integration.sh          # same, in dark mode (check the screenshots)
tests/run_reinstall_test.sh              # install over v1.0.0 without restarting; new styles and maths fonts must apply
HEADLESS=0 REAL_CLIPBOARD=1 tests/run_integration.sh   # Wayland: also paste a real clipboard image (briefly replaces your clipboard)
```

The end-to-end test starts a second Zotero with its own temporary profile and data folder, loads the plugin, and checks the chat UI in the library and the reader, request contents, note saving, maths (rendering, copying, notes), error handling, Stop, images, chat history (saving, switching, deleting, reloading after a restart), the settings pane, and disabling and re-enabling the plugin. It saves screenshots in the work directory's `out/` folder.

To develop against your own Zotero without rebuilding, use a proxy file. Quit Zotero, create a text file named `zotero-ai-chat@suresh-inbit` in your profile's `extensions` folder that contains the absolute path to `src`, then start Zotero.

### Updates

`manifest.json` points `update_url` at `update.json` on the `main` branch of this repository, so installed copies update themselves. For each release, upload the `.xpi` to a GitHub release and add an entry to `update.json` with its download link and SHA-256 (`sha256sum build/*.xpi`). The hash must be of the uploaded file itself: every build has a different hash, so don't rebuild after taking it.

## Credits

Maths is drawn by [KaTeX](https://katex.org) (MIT licence, see `src/content/katex/LICENSE`).
