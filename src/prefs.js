// Default preferences. Numbers are stored as strings because the settings pane
// writes input values back as strings.
pref("extensions.zotero-ai-chat.provider", "anthropic");

pref("extensions.zotero-ai-chat.anthropic.apiKey", "");
pref("extensions.zotero-ai-chat.anthropic.model", "claude-opus-5-5");
pref("extensions.zotero-ai-chat.anthropic.effort", "medium");
pref("extensions.zotero-ai-chat.anthropic.baseURL", "https://api.anthropic.com");

pref("extensions.zotero-ai-chat.openai.apiKey", "");
pref("extensions.zotero-ai-chat.openai.model", "");
pref("extensions.zotero-ai-chat.openai.baseURL", "https://api.openai.com/v1");

pref("extensions.zotero-ai-chat.maxContextChars", "200000");
pref("extensions.zotero-ai-chat.includeAnnotations", true);
pref("extensions.zotero-ai-chat.customInstructions", "");
