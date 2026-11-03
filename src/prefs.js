// Default preferences. Numbers are stored as strings because the settings pane
// writes input values back as strings.
pref("extensions.zotero-ai-chat.provider", "anthropic");

pref("extensions.zotero-ai-chat.anthropic.apiKey", "");
pref("extensions.zotero-ai-chat.anthropic.model", "claude-opus-5-5");
pref("extensions.zotero-ai-chat.anthropic.effort", "medium");
pref("extensions.zotero-ai-chat.anthropic.baseURL", "https://api.anthropic.com");
// Favorite models for the chat's model menu, one per line (commas also work)
pref("extensions.zotero-ai-chat.favoriteModels.anthropic", "claude-opus-5-5\nclaude-sonnet-5-5\nclaude-haiku-5-5");

pref("extensions.zotero-ai-chat.openai.apiKey", "");
pref("extensions.zotero-ai-chat.openai.model", "");
pref("extensions.zotero-ai-chat.openai.baseURL", "https://api.openai.com/v1");
pref("extensions.zotero-ai-chat.favoriteModels.openai", "");

// Hosted OpenAI-compatible services. Model IDs are "vendor/model" on OpenRouter; Requesty
// accepts the same form. Use "Load models from server" to see the full list.
pref("extensions.zotero-ai-chat.openrouter.apiKey", "");
pref("extensions.zotero-ai-chat.openrouter.model", "minimax/minimax-m3.1-flash");
pref("extensions.zotero-ai-chat.openrouter.baseURL", "https://openrouter.ai/api/v1");
pref("extensions.zotero-ai-chat.favoriteModels.openrouter", "minimax/minimax-m3.1-flash\ndeepseek/deepseek-v4.1-flash-1017\nopenai/gpt-6-luna");

pref("extensions.zotero-ai-chat.requesty.apiKey", "");
pref("extensions.zotero-ai-chat.requesty.model", "alibaba/qwen3.8-max");
pref("extensions.zotero-ai-chat.requesty.baseURL", "https://router.requesty.ai/v1");
pref("extensions.zotero-ai-chat.favoriteModels.requesty", "alibaba/qwen3.8-max\ndeepseek/deepseek-v4.1-flash-1017\nopenai/gpt-6-luna");

pref("extensions.zotero-ai-chat.maxContextChars", "200000");
pref("extensions.zotero-ai-chat.includeAnnotations", true);
pref("extensions.zotero-ai-chat.customInstructions", "");
// Save chats in <Zotero data directory>/ai-chat/ so they can be reopened later
pref("extensions.zotero-ai-chat.saveHistory", true);
