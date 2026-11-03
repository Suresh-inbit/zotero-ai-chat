/* global Zotero, Services, IOUtils, PathUtils, DOMParser, TextDecoder, setTimeout, clearTimeout */
/*
 * AI Chat for Zotero
 *
 * Adds an "AI Chat" section to the item pane (library and reader). Questions are
 * answered using the item's metadata, attachment full text and annotations as
 * context. Supports the Claude API and any OpenAI-compatible chat API.
 *
 * Loaded into the plugin's bootstrap scope by bootstrap.js.
 */

var AIChat = {
	id: null,
	version: null,
	rootURI: null,

	PREF_PREFIX: "extensions.zotero-ai-chat.",
	HTML_NS: "http://www.w3.org/1999/xhtml",
	SVG_NS: "http://www.w3.org/2000/svg",
	STYLE_ID: "zotero-ai-chat-style",
	FTL_FILE: "zotero-ai-chat.ftl",

	// Chat history: one JSON file per item in <Zotero data directory>/ai-chat/
	HISTORY_DIR: "ai-chat",
	MAX_CHATS_PER_ITEM: 50,
	// History files kept in memory (they can hold images, so not all of them)
	HISTORY_CACHE_SIZE: 20,

	// Claude uses the Anthropic API; the rest speak the OpenAI chat-completions format
	PROVIDERS: ["anthropic", "openai", "openrouter", "requesty"],
	// Image attachments: re-encoded to PNG (or JPEG if large), longest side capped
	MAX_IMAGES: 8,
	IMAGE_MAX_EDGE: 2000,
	IMAGE_MAX_BYTES: 4 * 1024 * 1024,
	// Clipboard formats an image can arrive in. Zotero's own "Copy Image" uses the native one.
	IMAGE_FLAVORS: ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "application/x-moz-nativeimage"],
	ANTHROPIC_VERSION: "2026-10-21",
	// Server-side refusal fallback. Only sent to the Claude API for models that accept
	// `fallbacks: "default"`; other models (e.g. Haiku) have no server-side fallback.
	FALLBACK_BETA: "server-side-fallback-2026-07-01",
	FALLBACK_MODELS: ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"],
	// Models that accept `output_config.effort`
	EFFORT_MODEL_RE: /^claude-(fable|mythos)-|^claude-(opus|sonnet|haiku)-5|^claude-opus-4-[5-8]|^claude-sonnet-4-6/,
	ANTHROPIC_MAX_TOKENS: 64000,

	SUGGESTIONS: [
		"Summarize this paper",
		"What are the key contributions?",
		"Explain the methodology",
		"What are the limitations?"
	],

	// Icons on a 16px grid, drawn as strokes in the text color (see .aichat-icon).
	// A string is a path; [tag, attributes] is any other shape.
	ICONS: {
		history: ["M2.5 8a5.5 5.5 0 1 0 1.61-3.89L2.5 5.5", "M2.5 2.75V5.5h2.75", "M8 5v3l2 1.25"],
		chevron: ["M4.5 6.5L8 10l3.5-3.5"],
		plus: ["M8 3.5v9", "M3.5 8h9"],
		note: ["M3.5 2.5h9V10l-3 3h-6z", "M12.5 10h-3v3", "M5.75 5.5h4.5", "M5.75 8h2.5"],
		settings: ["M2.5 5h3.5", "M9 5h4.5", "M2.5 11h7.5", "M13 11h.5",
			["circle", { cx: 7.5, cy: 5, r: 1.5 }], ["circle", { cx: 11.5, cy: 11, r: 1.5 }]],
		crop: ["M4.5 1.5v10h10", "M1.5 4.5h10v10"],
		image: [["rect", { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }], ["circle", { cx: 5.75, cy: 6.25, r: 1.1 }],
			"M2.5 11.5l3.25-3.25 2.5 2.5 1.75-1.75 3.5 3.5"],
		copy: [["rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }],
			"M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"],
		check: ["M3 8.5l3 3 7-7"],
		send: ["M8 12.5v-9", "M4 7.5l4-4 4 4"],
		stop: [["rect", { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1.25, fill: "currentColor", stroke: "none" }]],
		trash: ["M2.5 4.5h11", "M6.25 4.5V3a.5.5 0 0 1 .5-.5h2.5a.5.5 0 0 1 .5.5v1.5",
			"M4 4.5l.65 8.1a1 1 0 0 0 1 .9h4.7a1 1 0 0 0 1-.9L12 4.5"],
		close: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"]
	},

	paneID: null,
	prefPaneID: null,
	notifierID: null,
	conversations: new Map(),
	views: new Map(),
	// History file path -> Promise of its contents (most recently used last)
	historyCache: new Map(),
	// History file path -> Promise of the last queued write, so writes never overlap
	historyQueue: new Map(),
	// Item ID -> ID of the chat last open for it in this session
	lastChatIDs: new Map(),

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	async startup() {
		try {
			this.cssText = await Zotero.File.getResourceAsync(this.rootURI + "content/aichat.css");
		}
		catch (e) {
			Zotero.logError(e);
		}
		// KaTeX's styles go first, so the plugin's own rules can adjust them
		try {
			let katexCSS = await Zotero.File.getResourceAsync(this.rootURI + "content/katex/katex.min.css");
			this.cssText = AIChatMath.adaptCSS(katexCSS, this.rootURI + "content/katex/fonts/")
				+ "\n" + (this.cssText || "");
		}
		catch (e) {
			Zotero.logError(e);
		}

		// Keep every open chat (model menu, history) in step with changes made in Settings
		this.prefObserver = { observe: () => this.refreshViews() };
		Services.prefs.addObserver(this.PREF_PREFIX, this.prefObserver);

		// Deleting an item (emptying the trash) also deletes its saved chats
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids, extraData) => {
				if (event === "delete" && type === "item") this.onItemsDeleted(ids, extraData);
			}
		}, ["item"], "zotero-ai-chat");

		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "chat",
			pluginID: this.id,
			header: {
				l10nID: "zotero-ai-chat-header",
				icon: this.rootURI + "content/icons/icon16.svg",
				darkIcon: this.rootURI + "content/icons/icon16-dark.svg"
			},
			sidenav: {
				l10nID: "zotero-ai-chat-sidenav",
				icon: this.rootURI + "content/icons/icon20.svg",
				darkIcon: this.rootURI + "content/icons/icon20-dark.svg"
			},
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(this.isSupportedItem(item));
				return true;
			},
			onRender: ({ body, doc, item }) => {
				this.ensureStyle(doc);
				let view = this.views.get(body);
				if (!view) {
					view = new AIChatView(this, body, doc);
					this.views.set(body, view);
				}
				if (this.isSupportedItem(item)) {
					view.show(item);
				}
			},
			onDestroy: ({ body }) => {
				let view = this.views.get(body);
				if (view) {
					view.destroy();
					this.views.delete(body);
				}
			}
		});
		if (!this.paneID) {
			Zotero.logError(new Error("AI Chat: failed to register item pane section"));
		}

		this.prefPaneID = await Zotero.PreferencePanes.register({
			pluginID: this.id,
			src: this.rootURI + "content/preferences.xhtml",
			scripts: [this.rootURI + "content/preferences.js"],
			label: "AI Chat",
			image: this.rootURI + "content/icons/icon20.svg"
		});

		for (let win of Zotero.getMainWindows()) {
			this.addToWindow(win);
		}

		// Exposed so the settings pane script (which runs in the preferences window) can reach
		// us. Set last, so nothing sees a half-started plugin.
		Zotero.AIChat = this;
	},

	refreshViews() {
		for (let view of this.views.values()) {
			try {
				view.updateControls();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},

	shutdown() {
		if (this.prefObserver) {
			Services.prefs.removeObserver(this.PREF_PREFIX, this.prefObserver);
			this.prefObserver = null;
		}
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
		for (let conv of this.conversations.values()) {
			if (conv.abort) conv.abort.abort();
		}
		for (let view of this.views.values()) {
			view.destroy();
		}
		this.views.clear();
		this.conversations.clear();
		// Writes still queued finish on their own; nothing else needs the cached files
		this.historyCache.clear();
		this.lastChatIDs.clear();
		AIChatMath.reset();
		if (this.paneID) {
			Zotero.ItemPaneManager.unregisterSection(this.paneID);
			this.paneID = null;
		}
		if (this.prefPaneID) {
			Zotero.PreferencePanes.unregister(this.prefPaneID);
			this.prefPaneID = null;
		}
		for (let win of Zotero.getMainWindows()) {
			this.removeFromWindow(win);
		}
		if (Zotero.AIChat === this) {
			delete Zotero.AIChat;
		}
	},

	addToWindow(win) {
		// The section header and sidenav labels come from our Fluent file
		win.MozXULElement.insertFTLIfNeeded(this.FTL_FILE);
		this.ensureStyle(win.document);
	},

	removeFromWindow(win) {
		let doc = win.document;
		doc.getElementById(this.STYLE_ID)?.remove();
		doc.querySelector(`[href="${this.FTL_FILE}"]`)?.remove();
	},

	// The CSS is inserted as text rather than linked: Gecko caches linked sheets by URL,
	// so after installing a new build over a running one, a <link> would keep the old rules
	ensureStyle(doc) {
		if (!this.cssText) return;
		let style = doc.getElementById(this.STYLE_ID);
		if (style) {
			if (style.textContent !== this.cssText) style.textContent = this.cssText;
			return;
		}
		style = doc.createElementNS(this.HTML_NS, "style");
		style.id = this.STYLE_ID;
		style.textContent = this.cssText;
		doc.documentElement.appendChild(style);
	},

	isSupportedItem(item) {
		return !!item && (item.isRegularItem() || item.isAttachment() || item.isNote());
	},

	// ---------------------------------------------------------------------
	// Preferences
	// ---------------------------------------------------------------------

	getPref(key) {
		return Zotero.Prefs.get(this.PREF_PREFIX + key, true);
	},

	getSettings(providerOverride) {
		let stored = providerOverride || this.getPref("provider");
		let provider = this.PROVIDERS.includes(stored) ? stored : "anthropic";
		let str = (key) => String(this.getPref(`${provider}.${key}`) ?? "").trim();
		return {
			provider,
			apiKey: str("apiKey"),
			model: str("model"),
			baseURL: str("baseURL").replace(/\/+$/, ""),
			effort: provider === "anthropic" ? str("effort") : ""
		};
	},

	/**
	 * @return {String|null} - A message describing what is missing, or null if usable
	 */
	checkSettings(settings) {
		if (!settings.baseURL) {
			return "No API base URL is set. Open AI Chat settings to configure it.";
		}
		if (!/^https?:\/\//i.test(settings.baseURL)) {
			return `The API base URL must start with http:// or https:// (got "${settings.baseURL}").`;
		}
		if (!settings.model) {
			return "No model is set. Open AI Chat settings and enter a model name.";
		}
		if (settings.provider === "anthropic" && !settings.apiKey) {
			return "No Claude API key is set. Open AI Chat settings and paste your API key.";
		}
		if (["openrouter", "requesty"].includes(settings.provider) && !settings.apiKey) {
			const name = settings.provider === "openrouter" ? "OpenRouter" : "Requesty";
			return `No ${name} API key is set. Open AI Chat settings and paste your key.`;
		}
		return null;
	},

	/**
	 * @return {String[]} - Favorite model IDs for a provider, in the order they were entered
	 */
	getFavoriteModels(provider) {
		let list = String(Zotero.Prefs.get(this.PREF_PREFIX + "favoriteModels." + provider, true) ?? "");
		let models = [];
		for (let model of list.split(/[\n,]/).map((m) => m.trim())) {
			if (model && !models.includes(model)) models.push(model);
		}
		return models;
	},

	setModel(provider, model) {
		Zotero.Prefs.set(this.PREF_PREFIX + provider + ".model", model, true);
	},

	modelsURL(provider, baseURL) {
		if (provider === "anthropic") {
			let root = baseURL.replace(/\/v1\/messages$/, "").replace(/\/v1$/, "");
			return root + "/v1/models?limit=1000";
		}
		return baseURL.replace(/\/chat\/completions$/, "") + "/models";
	},

	/**
	 * Ask the API which models the key can use.
	 *
	 * @return {Promise<String[]>} - Sorted model IDs; throws with a readable message on failure
	 */
	async listModels(provider) {
		let settings = this.getSettings(provider);
		if (!settings.baseURL) {
			throw new Error("Set the API base URL first.");
		}
		if (!/^https?:\/\//i.test(settings.baseURL)) {
			throw new Error(`The API base URL must start with http:// or https:// (got "${settings.baseURL}").`);
		}
		if (provider === "anthropic" && !settings.apiKey) {
			throw new Error("Paste your Claude API key first.");
		}
		let win = Zotero.getMainWindow();
		if (!win) {
			throw new Error("The main Zotero window is not open.");
		}
		let controller = new win.AbortController();
		let timer = setTimeout(() => controller.abort(), 30000);
		try {
			let headers = {};
			if (provider === "anthropic") {
				headers["x-api-key"] = settings.apiKey;
				headers["anthropic-version"] = this.ANTHROPIC_VERSION;
				headers["anthropic-dangerous-direct-browser-access"] = "true";
			}
			else if (settings.apiKey) {
				headers.authorization = `Bearer ${settings.apiKey}`;
			}
			let response = await win.fetch(this.modelsURL(provider, settings.baseURL), {
				headers,
				signal: controller.signal
			});
			if (!response.ok) {
				throw this.httpError(response.status, await this.readError(response));
			}
			let json = await response.json();
			let ids = Array.isArray(json?.data)
				? json.data.map((m) => m?.id).filter((id) => typeof id === "string" && id)
				: [];
			if (!ids.length) {
				throw new Error("The server returned no models.");
			}
			return [...new Set(ids)].sort();
		}
		catch (e) {
			if (controller.signal.aborted) {
				throw new Error("Timed out after 30 seconds.");
			}
			throw e;
		}
		finally {
			clearTimeout(timer);
		}
	},

	openSettings() {
		Zotero.Utilities.Internal.openPreferences(this.prefPaneID);
	},

	// ---------------------------------------------------------------------
	// Conversations
	// ---------------------------------------------------------------------

	newChatID() {
		this.chatSeq = (this.chatSeq || 0) + 1;
		return Date.now().toString(36) + "-" + this.chatSeq.toString(36) + Math.random().toString(36).slice(2, 6);
	},

	/**
	 * The live chat state for an item: the open chat's messages plus what is being typed.
	 * Earlier chats about the item live in its history file.
	 */
	getConversation(item) {
		let conv = this.conversations.get(item.id);
		if (!conv) {
			conv = {
				itemID: item.id,
				libraryID: item.libraryID,
				key: item.key,
				chatID: this.newChatID(),
				created: Date.now(),
				// Number of messages already in the history file for this chat
				savedLength: 0,
				messages: [],
				context: null,
				busy: false,
				abort: null,
				draft: "",
				pendingImages: [],
				listeners: new Set(),
				notifyTimer: null,
				turn: null,
				historyChecked: false,
				restoring: false,
				// Bumped whenever this item's history file changes, so an open history list refreshes
				historyVersion: 0
			};
			this.conversations.set(item.id, conv);
		}
		return conv;
	},

	/**
	 * Whether an idle conversation can be dropped from memory without losing anything,
	 * because everything in it is in the history file and it can be reloaded from there.
	 */
	canForget(conv) {
		if (conv.busy || conv.draft || conv.pendingImages.length || conv.listeners.size) return false;
		if (!conv.messages.length) return true;
		return this.historyEnabled() && this.hasHistoryKey(conv)
			&& conv.savedLength === conv.messages.length
			&& this.serializeMessages(conv.messages).length === conv.messages.length;
	},

	notify(conv) {
		if (conv.notifyTimer) {
			clearTimeout(conv.notifyTimer);
			conv.notifyTimer = null;
		}
		for (let listener of conv.listeners) {
			try {
				listener();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},

	// Coalesce rapid streaming updates into one UI refresh
	scheduleNotify(conv) {
		if (conv.notifyTimer) return;
		conv.notifyTimer = setTimeout(() => {
			conv.notifyTimer = null;
			this.notify(conv);
		}, 60);
	},

	// "New chat": the current chat stays in the history and an empty one starts
	clearConversation(conv) {
		this.resetConversation(conv, { persist: true });
	},

	resetConversation(conv, { persist = true, keepComposer = false } = {}) {
		if (persist) this.persistChat(conv);
		if (conv.abort) conv.abort.abort();
		// Detach any in-flight request so its completion doesn't touch the new chat
		conv.turn = null;
		conv.busy = false;
		conv.abort = null;
		conv.messages = [];
		conv.context = null;
		if (!keepComposer) conv.pendingImages = [];
		conv.chatID = this.newChatID();
		conv.created = Date.now();
		conv.savedLength = 0;
		conv.restoring = false;
		this.lastChatIDs.set(conv.itemID, conv.chatID);
		this.notify(conv);
	},

	// Ask a failed question again, with the same images
	retry(conv, item, win, replyIndex) {
		let user = conv.messages[replyIndex - 1];
		let reply = conv.messages[replyIndex];
		if (conv.busy || user?.role !== "user" || !["error", "refused"].includes(reply?.status)) {
			return Promise.resolve();
		}
		conv.messages.splice(replyIndex - 1, 2);
		// The failed request put its images back in the tray; they go with the retry instead
		let ids = new Set((user.images || []).map((i) => i.id));
		conv.pendingImages = conv.pendingImages.filter((i) => !ids.has(i.id));
		return this.send(conv, item, win, user.text, user.images || []);
	},

	/**
	 * Messages are stored as user/assistant pairs. Only pairs with a usable answer are
	 * sent back to the model; failed or refused turns are left out. Assistant turns are
	 * sent as plain text (no thinking blocks), which keeps the history valid across models.
	 */
	buildHistory(conv) {
		let history = [];
		for (let i = 0; i + 1 < conv.messages.length; i += 2) {
			let user = conv.messages[i];
			let reply = conv.messages[i + 1];
			if ((reply.status === "done" || reply.status === "stopped") && reply.text.trim()) {
				history.push(user.images?.length
					? { role: "user", content: user.text, images: user.images }
					: { role: "user", content: user.text });
				history.push({ role: "assistant", content: reply.text });
			}
		}
		return history;
	},

	async send(conv, item, win, question, images = []) {
		question = question.trim();
		if ((!question && !images.length) || conv.busy) return;

		let settings = this.getSettings();
		let history = this.buildHistory(conv);
		let reply = { role: "assistant", text: "", status: "streaming", phase: null, model: settings.model };
		conv.messages.push({ role: "user", text: question, images, status: "done" }, reply);
		conv.restoring = false;
		this.lastChatIDs.set(conv.itemID, conv.chatID);

		let problem = this.checkSettings(settings);
		if (problem) {
			reply.status = "error";
			reply.error = problem;
			reply.needsSettings = true;
			this.restoreImages(conv, reply, images);
			this.notify(conv);
			return;
		}

		let controller = new win.AbortController();
		let turn = {};
		conv.turn = turn;
		conv.busy = true;
		conv.abort = controller;
		this.notify(conv);

		try {
			if (!conv.context) {
				reply.phase = "Reading the item…";
				this.notify(conv);
				let context = await this.buildContext(item, win);
				if (controller.signal.aborted) {
					throw new Error("Aborted");
				}
				conv.context = context;
			}
			reply.phase = "Thinking…";
			this.notify(conv);

			let messages = history.concat(images.length
				? { role: "user", content: question, images }
				: { role: "user", content: question });
			let onText = (delta) => {
				reply.phase = null;
				reply.text += delta;
				this.scheduleNotify(conv);
			};
			let result = settings.provider !== "anthropic"
				? await this.streamOpenAI(settings, conv.context, messages, controller.signal, win, onText)
				: await this.streamAnthropic(settings, conv.context, messages, controller.signal, win, onText);

			reply.phase = null;
			if (result.model) reply.model = result.model;
			if (result.stopReason === "refusal") {
				// A refused answer may be partial; discard it rather than present it as complete
				reply.status = "refused";
				reply.text = "";
				reply.error = "The model declined to answer this request.";
			}
			else if (!reply.text.trim()) {
				reply.status = "error";
				reply.error = "The model returned an empty response"
					+ (result.stopReason ? ` (stop reason: ${result.stopReason}).` : ".");
			}
			else {
				reply.status = "done";
				if (result.stopReason === "max_tokens" || result.stopReason === "length") {
					reply.notice = "The answer was cut off because it reached the output length limit.";
				}
			}
		}
		catch (e) {
			reply.phase = null;
			if (controller.signal.aborted) {
				reply.status = "stopped";
			}
			else {
				reply.status = "error";
				reply.error = e.message || String(e);
				Zotero.debug("AI Chat: request failed: " + reply.error);
			}
		}
		finally {
			if (conv.turn === turn) {
				conv.turn = null;
				conv.busy = false;
				conv.abort = null;
			}
			this.restoreImages(conv, reply, images);
			this.notify(conv);
		}
		// Unless the chat was replaced meanwhile (New chat), save it with the new answer
		if (conv.messages.includes(reply)) {
			await this.persistChat(conv);
		}
	},

	// A failed request shouldn't cost the user their crops: put the images back in the tray
	restoreImages(conv, reply, images) {
		if (!images.length || !["error", "refused"].includes(reply.status) || !conv.messages.includes(reply)) return;
		let have = new Set(conv.pendingImages.map((i) => i.id));
		conv.pendingImages = images.filter((i) => !have.has(i.id)).concat(conv.pendingImages).slice(0, this.MAX_IMAGES);
	},

	// ---------------------------------------------------------------------
	// Chat history
	//
	// Each item's chats are kept in <Zotero data directory>/ai-chat/<libraryID>_<itemKey>.json
	// as { version, libraryID, key, chats: [{ id, title, created, updated, messages }] },
	// newest chat first. A chat is saved after each answer; failed turns are not saved.
	// ---------------------------------------------------------------------

	historyEnabled() {
		return this.getPref("saveHistory") !== false;
	},

	historyDir() {
		return PathUtils.join(Zotero.DataDirectory.dir, this.HISTORY_DIR);
	},

	historyPath(libraryID, key) {
		return PathUtils.join(this.historyDir(), `${libraryID}_${key}.json`);
	},

	isHistoryKey(libraryID, key) {
		return Number.isInteger(libraryID) && typeof key === "string" && /^[A-Za-z0-9]+$/.test(key);
	},

	hasHistoryKey(conv) {
		return this.isHistoryKey(conv.libraryID, conv.key);
	},

	// Only exchanges that got an answer are kept; failed and refused turns are left out
	serializeMessages(messages) {
		let out = [];
		for (let i = 0; i + 1 < messages.length; i += 2) {
			let user = messages[i];
			let reply = messages[i + 1];
			// An answer interrupted by New chat is kept, as stopped
			let status = reply.status === "streaming" ? "stopped" : reply.status;
			if (!["done", "stopped"].includes(status) || !reply.text?.trim()) continue;
			out.push(
				{
					role: "user",
					text: user.text || "",
					images: (user.images || []).map((img) => ({
						mediaType: img.mediaType, data: img.data, width: img.width, height: img.height
					}))
				},
				{ role: "assistant", text: reply.text, status, model: reply.model || "", notice: reply.notice || "" }
			);
		}
		return out;
	},

	// Validate a chat read from disk; returns null if nothing usable is left
	cleanStoredChat(chat) {
		if (!chat || typeof chat.id !== "string" || !chat.id || !Array.isArray(chat.messages)) return null;
		let messages = [];
		for (let i = 0; i + 1 < chat.messages.length; i += 2) {
			let user = chat.messages[i];
			let reply = chat.messages[i + 1];
			if (user?.role !== "user" || reply?.role !== "assistant"
					|| typeof reply.text !== "string" || !reply.text.trim()) {
				continue;
			}
			let images = (Array.isArray(user.images) ? user.images : [])
				.filter((img) => img && typeof img.data === "string" && img.data
					&& /^image\/(png|jpeg|gif|webp)$/.test(img.mediaType))
				.map((img) => ({
					mediaType: img.mediaType, data: img.data, width: Number(img.width) || 0, height: Number(img.height) || 0
				}));
			messages.push(
				{ role: "user", text: typeof user.text === "string" ? user.text : "", images },
				{
					role: "assistant",
					text: reply.text,
					status: reply.status === "stopped" ? "stopped" : "done",
					model: typeof reply.model === "string" ? reply.model : "",
					notice: typeof reply.notice === "string" ? reply.notice : ""
				}
			);
		}
		if (!messages.length) return null;
		let created = Number(chat.created) || 0;
		return {
			id: chat.id,
			title: typeof chat.title === "string" && chat.title ? chat.title : this.chatTitle(messages),
			created,
			updated: Number(chat.updated) || created,
			messages
		};
	},

	chatTitle(messages) {
		let first = messages.find((m) => m.role === "user" && m.text?.trim());
		if (!first) return messages.length ? "Question about an image" : "New chat";
		let text = first.text.replace(/\s+/g, " ").trim();
		return text.length > 80 ? text.slice(0, 79) + "…" : text;
	},

	// Reads wait for queued writes, so they always see the latest saved state
	async readHistory(libraryID, key) {
		let path = this.historyPath(libraryID, key);
		await this.historyQueue.get(path);
		return this.loadHistoryFile(path);
	},

	loadHistoryFile(path) {
		let entry = this.historyCache.get(path);
		if (entry) {
			this.historyCache.delete(path);
		}
		else {
			entry = this.readHistoryFile(path);
		}
		this.historyCache.set(path, entry);
		while (this.historyCache.size > this.HISTORY_CACHE_SIZE) {
			this.historyCache.delete(this.historyCache.keys().next().value);
		}
		return entry;
	},

	async readHistoryFile(path) {
		let empty = { chats: [] };
		try {
			if (!(await IOUtils.exists(path))) return empty;
			let json = await IOUtils.readJSON(path);
			let chats = (Array.isArray(json?.chats) ? json.chats : [])
				.map((c) => this.cleanStoredChat(c))
				.filter(Boolean)
				.sort((a, b) => b.updated - a.updated);
			return { chats };
		}
		catch (e) {
			Zotero.logError(e);
			// Set an unreadable file aside rather than overwrite it with the next save
			try {
				await IOUtils.move(path, path.replace(/\.json$/, "") + `.unreadable-${Date.now()}.json`);
			}
			catch (e2) {}
			return empty;
		}
	},

	/**
	 * Change an item's history and write it to disk. Changes to one file run one at a time.
	 *
	 * @param {Function} change - Called with { chats } to modify in place
	 */
	updateHistory(libraryID, key, change) {
		let path = this.historyPath(libraryID, key);
		let previous = this.historyQueue.get(path) || Promise.resolve();
		let next = previous.then(async () => {
			let data = await this.loadHistoryFile(path);
			change(data);
			if (data.chats.length) {
				await IOUtils.makeDirectory(this.historyDir(), { ignoreExisting: true, createAncestors: true });
				await IOUtils.writeJSON(path, { version: 1, libraryID, key, chats: data.chats }, { tmpPath: path + ".tmp" });
			}
			else {
				await IOUtils.remove(path, { ignoreAbsent: true });
			}
		}).catch((e) => {
			Zotero.logError(e);
			// What's in memory may now differ from the file; read it again next time
			this.historyCache.delete(path);
		});
		this.historyQueue.set(path, next);
		next.then(() => {
			if (this.historyQueue.get(path) === next) this.historyQueue.delete(path);
		});
		return next;
	},

	/**
	 * Save the open chat if it has answers that aren't in the history file yet. The chat's
	 * contents are captured right away, so the conversation can change while this writes.
	 */
	persistChat(conv) {
		if (!this.historyEnabled() || !this.hasHistoryKey(conv)) return Promise.resolve();
		let messages = this.serializeMessages(conv.messages);
		if (!messages.length || messages.length === conv.savedLength) return Promise.resolve();
		conv.savedLength = messages.length;
		let chat = {
			id: conv.chatID,
			title: this.chatTitle(messages),
			created: conv.created,
			updated: Date.now(),
			messages
		};
		return this.updateHistory(conv.libraryID, conv.key, (data) => {
			data.chats = data.chats.filter((c) => c.id !== chat.id);
			data.chats.unshift(chat);
			data.chats.length = Math.min(data.chats.length, this.MAX_CHATS_PER_ITEM);
		}).then(() => {
			conv.historyVersion++;
			this.notify(conv);
		});
	},

	/**
	 * @return {Promise<Object[]>} - { id, title, created, updated, count } per saved chat, newest first
	 */
	async listChats(conv) {
		if (!this.historyEnabled() || !this.hasHistoryKey(conv)) return [];
		let data = await this.readHistory(conv.libraryID, conv.key);
		return data.chats.map((c) => ({
			id: c.id, title: c.title, created: c.created, updated: c.updated, count: c.messages.length / 2
		}));
	},

	/**
	 * Switch the conversation to a saved chat. Not while an answer is being written.
	 *
	 * @return {Promise<Boolean>} - Whether the chat was opened
	 */
	async openChat(conv, chatID) {
		if (conv.busy) return false;
		if (chatID === conv.chatID) return true;
		let data = await this.readHistory(conv.libraryID, conv.key);
		let chat = data.chats.find((c) => c.id === chatID);
		if (!chat || conv.busy) return false;
		this.persistChat(conv);
		this.loadChatInto(conv, chat);
		return true;
	},

	loadChatInto(conv, chat) {
		conv.chatID = chat.id;
		conv.created = chat.created;
		conv.messages = chat.messages.map((m) => (m.role === "user"
			? { role: "user", text: m.text, images: m.images.map((img) => this.restoreImage(img)), status: "done" }
			: { role: "assistant", text: m.text, status: m.status, phase: null, model: m.model, notice: m.notice || undefined }));
		conv.savedLength = chat.messages.length;
		// The item may have changed since; read it again for the next question
		conv.context = null;
		conv.restoring = false;
		this.lastChatIDs.set(conv.itemID, chat.id);
		this.notify(conv);
	},

	restoreImage(img) {
		this.imageSeq = (this.imageSeq || 0) + 1;
		return {
			id: `${Date.now()}-${this.imageSeq}`,
			mediaType: img.mediaType,
			data: img.data,
			dataURL: `data:${img.mediaType};base64,${img.data}`,
			width: img.width,
			height: img.height
		};
	},

	/**
	 * When an item is shown for the first time in a session, reopen its most recent chat.
	 * Later in the session, reopen whichever chat was last open for it (or none, after New chat).
	 */
	async restoreChat(conv) {
		if (conv.historyChecked) return;
		conv.historyChecked = true;
		if (!this.historyEnabled() || !this.hasHistoryKey(conv)) return;
		let chatID = conv.chatID;
		conv.restoring = true;
		this.notify(conv);
		try {
			let data = await this.readHistory(conv.libraryID, conv.key);
			// The user started typing a question or a new chat meanwhile
			if (conv.chatID !== chatID || conv.messages.length || conv.busy) return;
			let chat = this.lastChatIDs.has(conv.itemID)
				? data.chats.find((c) => c.id === this.lastChatIDs.get(conv.itemID))
				: data.chats[0];
			if (chat) this.loadChatInto(conv, chat);
		}
		catch (e) {
			Zotero.logError(e);
		}
		finally {
			if (conv.restoring) {
				conv.restoring = false;
				this.notify(conv);
			}
		}
	},

	async deleteChat(conv, chatID) {
		if (!this.hasHistoryKey(conv)) return;
		// Reset first, so an answer still arriving can't save the chat again
		if (conv.chatID === chatID) {
			this.resetConversation(conv, { persist: false, keepComposer: true });
		}
		await this.updateHistory(conv.libraryID, conv.key, (data) => {
			data.chats = data.chats.filter((c) => c.id !== chatID);
		});
		conv.historyVersion++;
		this.notify(conv);
	},

	deleteItemHistory(libraryID, key) {
		if (!this.isHistoryKey(libraryID, key)) return Promise.resolve();
		return this.updateHistory(libraryID, key, (data) => {
			data.chats = [];
		}).then(() => {
			this.historyCache.delete(this.historyPath(libraryID, key));
		});
	},

	onItemsDeleted(ids, extraData) {
		for (let id of ids) {
			let conv = this.conversations.get(id);
			if (conv) {
				this.resetConversation(conv, { persist: false });
				this.conversations.delete(id);
			}
			this.lastChatIDs.delete(id);
			let info = extraData?.[id];
			if (info) this.deleteItemHistory(info.libraryID, info.key);
		}
	},

	// Settings > Delete all chat history. Open chats are emptied too, since they're part of it.
	async clearAllHistory() {
		for (let conv of this.conversations.values()) {
			this.resetConversation(conv, { persist: false, keepComposer: true });
		}
		await Promise.all([...this.historyQueue.values()]);
		this.historyCache.clear();
		this.lastChatIDs.clear();
		await IOUtils.remove(this.historyDir(), { recursive: true, ignoreAbsent: true });
		for (let conv of this.conversations.values()) {
			conv.historyVersion++;
			this.notify(conv);
		}
	},

	clipboardHas(flavors) {
		let clipboard = Services.clipboard;
		return flavors.some((flavor) => {
			try {
				return clipboard.hasDataMatchingFlavors([flavor], clipboard.kGlobalClipboard);
			}
			catch (e) {
				return false;
			}
		});
	},

	clipboardHasText() {
		return this.clipboardHas(["text/plain"]);
	},

	clipboardHasImage() {
		return this.clipboardHas(this.IMAGE_FLAVORS);
	},

	// For Help > Debug Output Logging, when a paste doesn't do what the user expects
	logClipboard(context) {
		let found = ["text/plain", ...this.IMAGE_FLAVORS].filter((f) => this.clipboardHas([f]));
		Zotero.debug(`AI Chat: ${context}: clipboard has ${found.length ? found.join(", ") : "nothing readable"}`);
	},

	/**
	 * Read an image straight from the system clipboard. Needed because in Zotero's windows
	 * (privileged documents) a text box only runs Paste when the clipboard holds text, so an
	 * image-only clipboard never produces a paste event.
	 *
	 * @return {Promise<Blob|null>}
	 */
	async readClipboardImage(win) {
		const { classes: Cc, interfaces: Ci } = Components;
		let clipboard = Services.clipboard;
		for (let flavor of this.IMAGE_FLAVORS) {
			if (!this.clipboardHas([flavor])) continue;
			let trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
			trans.init(null);
			trans.addDataFlavor(flavor);
			clipboard.getData(trans, clipboard.kGlobalClipboard);
			let data = {};
			try {
				trans.getTransferData(flavor, data);
			}
			catch (e) {
				continue;
			}
			let value = data.value;
			let type = flavor;
			if (value instanceof Ci.nsISupportsInterfacePointer) value = value.data;
			if (value instanceof Ci.imgIContainer) {
				value = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools).encodeImage(value, "image/png");
				type = "image/png";
			}
			if (!(value instanceof Ci.nsIInputStream)) continue;
			let stream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
			stream.setInputStream(value);
			let bytes = new Uint8Array(stream.readByteArray(stream.available()));
			if (!bytes.length) continue;
			return new win.Blob([bytes], { type: type === "application/x-moz-nativeimage" ? "image/png" : type });
		}
		return null;
	},

	toAnthropicMessages(messages) {
		return messages.map((m) => {
			if (!m.images?.length) return { role: m.role, content: m.content };
			let content = m.images.map((img) => ({
				type: "image",
				source: { type: "base64", media_type: img.mediaType, data: img.data }
			}));
			if (m.content) content.push({ type: "text", text: m.content });
			return { role: m.role, content };
		});
	},

	toOpenAIMessages(messages) {
		return messages.map((m) => {
			if (!m.images?.length) return { role: m.role, content: m.content };
			let content = [];
			if (m.content) content.push({ type: "text", text: m.content });
			for (let img of m.images) {
				content.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
			}
			return { role: m.role, content };
		});
	},

	/**
	 * Turn a Blob (pasted file) or ImageBitmap (screen crop) into an attachable image:
	 * flattened onto white, longest side capped, PNG unless that is too big for the API.
	 *
	 * @return {Promise<Object>} - { id, mediaType, data (base64), dataURL, width, height }
	 */
	async prepareImage(win, source) {
		let isBitmap = typeof source.close === "function" && "width" in source;
		let bitmap;
		try {
			bitmap = isBitmap ? source : await win.createImageBitmap(source);
		}
		catch (e) {
			throw new Error("That file isn't an image Zotero can read.");
		}
		try {
			let scale = Math.min(1, this.IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
			for (let attempt = 0; attempt < 6; attempt++) {
				let width = Math.max(1, Math.round(bitmap.width * scale));
				let height = Math.max(1, Math.round(bitmap.height * scale));
				let canvas = win.document.createElementNS(this.HTML_NS, "canvas");
				canvas.width = width;
				canvas.height = height;
				let ctx = canvas.getContext("2d");
				ctx.fillStyle = "#fff";
				ctx.fillRect(0, 0, width, height);
				ctx.drawImage(bitmap, 0, 0, width, height);
				let toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
				let mediaType = "image/png";
				let blob = await toBlob(mediaType);
				if (blob && blob.size > this.IMAGE_MAX_BYTES) {
					mediaType = "image/jpeg";
					blob = await toBlob(mediaType, 0.9);
				}
				if (blob && blob.size <= this.IMAGE_MAX_BYTES) {
					let bytes = new Uint8Array(await blob.arrayBuffer());
					let binary = "";
					for (let i = 0; i < bytes.length; i += 0x8000) {
						binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
					}
					let data = btoa(binary);
					this.imageSeq = (this.imageSeq || 0) + 1;
					return {
						id: `${Date.now()}-${this.imageSeq}`,
						mediaType,
						data,
						dataURL: `data:${mediaType};base64,${data}`,
						width,
						height
					};
				}
				scale *= 0.75;
			}
			throw new Error("The image is too large to send, even after shrinking it.");
		}
		finally {
			if (!isBitmap) bitmap.close();
		}
	},

	// ---------------------------------------------------------------------
	// Item context
	// ---------------------------------------------------------------------

	getMaxContextChars() {
		let n = parseInt(this.getPref("maxContextChars"), 10);
		return Number.isFinite(n) && n >= 0 ? n : 200000;
	},

	async getAttachmentFor(item, win) {
		if (item.isAttachment()) return item;
		if (!item.isRegularItem()) return null;
		// In a reader tab, use the attachment that is open there
		try {
			let tabID = win?.Zotero_Tabs?.selectedID;
			let reader = tabID && Zotero.Reader.getByTabID(tabID);
			if (reader) {
				let open = Zotero.Items.get(reader.itemID);
				if (open && open.parentItemID === item.id) return open;
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		return (await item.getBestAttachment()) || null;
	},

	formatCreators(item) {
		return item.getCreators().map((c) => {
			return c.fieldMode == 1 ? c.lastName : [c.firstName, c.lastName].filter(Boolean).join(" ");
		}).filter(Boolean);
	},

	getFieldSafe(item, field) {
		try {
			return item.getField(field) || "";
		}
		catch (e) {
			return "";
		}
	},

	/**
	 * Gather metadata, full text and annotations for an item.
	 *
	 * @return {Promise<Object>} - { system, document, summary, truncated, hasText }
	 */
	async buildContext(item, win) {
		let maxChars = this.getMaxContextChars();
		let attachment = await this.getAttachmentFor(item, win);
		let metaItem = item.isRegularItem()
			? item
			: (item.parentItem && item.parentItem.isRegularItem() ? item.parentItem : null);

		let meta = [];
		if (metaItem) {
			meta.push(`Item type: ${Zotero.ItemTypes.getLocalizedString(metaItem.itemTypeID)}`);
			let fields = [
				["Title", "title"],
				["Date", "date"],
				["Publication", "publicationTitle"],
				["DOI", "DOI"],
				["URL", "url"]
			];
			for (let [label, field] of fields) {
				let value = this.getFieldSafe(metaItem, field);
				if (value) meta.push(`${label}: ${value}`);
				if (field === "title") {
					let creators = this.formatCreators(metaItem);
					if (creators.length) meta.push(`Authors: ${creators.join("; ")}`);
				}
			}
			let abstract = this.getFieldSafe(metaItem, "abstractNote");
			if (abstract) meta.push(`Abstract: ${abstract}`);
		}
		else if (item.isNote()) {
			meta.push(`Item type: Note`);
			meta.push(`Title: ${item.getNoteTitle()}`);
		}
		if (attachment) {
			meta.push(`Attachment: ${attachment.getField("title") || attachment.attachmentFilename || "untitled"}`);
		}

		let text = "";
		let source = "";
		if (item.isNote()) {
			text = Zotero.Utilities.unescapeHTML(item.getNote() || "");
			source = "note";
		}
		else if (attachment) {
			try {
				text = (await attachment.attachmentText) || "";
			}
			catch (e) {
				Zotero.logError(e);
				text = "";
			}
			source = attachment.attachmentFilename || attachment.getField("title") || "attachment";
		}
		text = text.trim();
		let fullLength = text.length;
		let truncated = fullLength > maxChars;
		if (truncated) text = text.slice(0, maxChars);

		let annotations = [];
		if (attachment && this.getPref("includeAnnotations") && attachment.isFileAttachment()) {
			try {
				for (let a of attachment.getAnnotations()) {
					let parts = [];
					if (a.annotationPageLabel) parts.push(`[page ${a.annotationPageLabel}]`);
					parts.push(`(${a.annotationType})`);
					if (a.annotationText) parts.push(`"${a.annotationText}"`);
					if (a.annotationComment) parts.push(`Comment: ${a.annotationComment}`);
					if (a.annotationText || a.annotationComment) annotations.push(parts.join(" "));
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		let custom = String(this.getPref("customInstructions") || "").trim();
		let system = "You are a research assistant inside Zotero, a reference manager. "
			+ "The user is reading the item described in the context below and asks questions about it. "
			+ "Base your answers on the provided document text whenever possible, and cite page numbers "
			+ "or section names when you can. If the answer is not in the document, say so, and clearly "
			+ "mark anything that comes from your general knowledge instead. "
			+ "Keep responses focused and concise unless the user asks for depth. Format answers in Markdown, "
			+ "and write mathematics in LaTeX: \\( … \\) for inline maths and \\[ … \\] for displayed equations."
			+ (custom ? `\n\nAdditional instructions from the user:\n${custom}` : "");

		let doc = "<item_metadata>\n" + (meta.join("\n") || "No metadata available.") + "\n</item_metadata>\n\n";
		if (text) {
			doc += `<document_text source="${this.escapeAttr(source)}"`
				+ (truncated ? ` truncated="true" included_chars="${maxChars}" total_chars="${fullLength}"` : "")
				+ `>\n${text}\n</document_text>\n`;
		}
		else {
			doc += "<document_text>No full text is available for this item (no readable attachment, "
				+ "or the attachment has not been indexed yet). Only the metadata above is available."
				+ "</document_text>\n";
		}
		if (annotations.length) {
			doc += `\n<user_annotations>\n${annotations.join("\n")}\n</user_annotations>\n`;
		}

		let summary;
		if (text) {
			summary = `${source} · ${fullLength.toLocaleString()} characters`;
			if (truncated) {
				summary += ` (first ${maxChars.toLocaleString()} sent; raise the limit in settings to send more)`;
			}
		}
		else {
			summary = "No full text found, so answers will use metadata only";
		}
		if (annotations.length) {
			summary += ` · ${annotations.length} annotation${annotations.length == 1 ? "" : "s"}`;
		}

		return { system, document: doc, summary, truncated, hasText: !!text };
	},

	escapeAttr(str) {
		return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
	},

	// ---------------------------------------------------------------------
	// Providers
	// ---------------------------------------------------------------------

	anthropicURL(baseURL) {
		if (/\/v1\/messages$/.test(baseURL)) return baseURL;
		if (/\/v1$/.test(baseURL)) return baseURL + "/messages";
		return baseURL + "/v1/messages";
	},

	openAIURL(baseURL) {
		if (/\/chat\/completions$/.test(baseURL)) return baseURL;
		return baseURL + "/chat/completions";
	},

	async readError(response) {
		let text = "";
		try {
			text = await response.text();
		}
		catch (e) {}
		let message = "";
		try {
			let json = JSON.parse(text);
			message = json?.error?.message || json?.message || (typeof json?.error === "string" ? json.error : "");
		}
		catch (e) {}
		if (!message) message = text.slice(0, 500);
		return message;
	},

	httpError(status, message) {
		let hint = "";
		if (status === 401 || status === 403) hint = " Check your API key in AI Chat settings.";
		else if (status === 404) hint = " Check the base URL and model name in AI Chat settings.";
		else if (status === 429) hint = " You are being rate limited; wait a moment and try again.";
		else if (status === 529 || status === 503) hint = " The service is overloaded; try again shortly.";
		return new Error(`API error ${status}: ${message || "request failed"}.${hint}`.replace(/\.\./g, "."));
	},

	/**
	 * Parse a Server-Sent Events stream, calling onEvent(eventName, data) per event.
	 */
	async readSSE(response, onEvent) {
		let reader = response.body.getReader();
		let decoder = new TextDecoder();
		let buffer = "";
		let eventName = "";
		let dataLines = [];
		let dispatch = () => {
			if (dataLines.length) {
				onEvent(eventName || "message", dataLines.join("\n"));
			}
			eventName = "";
			dataLines = [];
		};
		let handleLine = (line) => {
			if (line === "") {
				dispatch();
			}
			else if (line.startsWith(":")) {
				// Comment / keep-alive
			}
			else {
				let idx = line.indexOf(":");
				let field = idx === -1 ? line : line.slice(0, idx);
				let value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
				if (field === "event") eventName = value;
				else if (field === "data") dataLines.push(value);
			}
		};
		try {
			while (true) {
				let { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// A chunk can end between the \r and \n of a CRLF; hold the \r back so the
				// pair isn't read as two line breaks
				let holdCR = buffer.endsWith("\r");
				let lines = (holdCR ? buffer.slice(0, -1) : buffer).split(/\r\n|\r|\n/);
				buffer = lines.pop() + (holdCR ? "\r" : "");
				for (let line of lines) handleLine(line);
			}
			buffer += decoder.decode();
			if (buffer) {
				for (let line of buffer.split(/\r\n|\r|\n/)) handleLine(line);
			}
			dispatch();
		}
		finally {
			try {
				reader.releaseLock();
			}
			catch (e) {}
		}
	},

	async streamAnthropic(settings, context, messages, signal, win, onText) {
		let url = this.anthropicURL(settings.baseURL);
		let isClaudeAPI = /^https:\/\/api\.anthropic\.com\//.test(url);
		let useFallbacks = isClaudeAPI && this.FALLBACK_MODELS.includes(settings.model);
		let useEffort = !!settings.effort && this.EFFORT_MODEL_RE.test(settings.model);

		// The document goes in its own system block with a cache breakpoint, so follow-up
		// questions about the same item read it from the prompt cache.
		let body = {
			model: settings.model,
			max_tokens: this.ANTHROPIC_MAX_TOKENS,
			stream: true,
			system: [
				{ type: "text", text: context.system },
				{ type: "text", text: context.document, cache_control: { type: "ephemeral" } }
			],
			messages: this.toAnthropicMessages(messages)
		};

		let response;
		for (let attempt = 0; attempt < 3; attempt++) {
			let request = Object.assign({}, body);
			let headers = {
				"content-type": "application/json",
				"x-api-key": settings.apiKey,
				"anthropic-version": this.ANTHROPIC_VERSION,
				"anthropic-dangerous-direct-browser-access": "true"
			};
			if (useEffort) {
				request.output_config = { effort: settings.effort };
			}
			if (useFallbacks) {
				request.fallbacks = "default";
				headers["anthropic-beta"] = this.FALLBACK_BETA;
			}
			response = await win.fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(request),
				signal
			});
			if (response.ok) break;

			let message = await this.readError(response);
			// If an optional feature is rejected (e.g. an older model or a proxy), retry without it
			if (response.status === 400 && useFallbacks && /fallback/i.test(message)) {
				useFallbacks = false;
				continue;
			}
			if (response.status === 400 && useEffort && /effort|output_config/i.test(message)) {
				useEffort = false;
				continue;
			}
			throw this.httpError(response.status, message);
		}

		let stopReason = null;
		let model = null;
		let streamError = null;
		await this.readSSE(response, (event, data) => {
			let json;
			try {
				json = JSON.parse(data);
			}
			catch (e) {
				return;
			}
			switch (json.type) {
				case "message_start":
					model = json.message?.model || model;
					break;
				case "content_block_delta":
					if (json.delta?.type === "text_delta" && json.delta.text) {
						onText(json.delta.text);
					}
					break;
				case "message_delta":
					if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
					break;
				case "error":
					streamError = json.error?.message || "The stream returned an error.";
					break;
			}
		});
		if (streamError) {
			throw new Error(`API error: ${streamError}`);
		}
		return { stopReason, model };
	},

	async streamOpenAI(settings, context, messages, signal, win, onText) {
		let url = this.openAIURL(settings.baseURL);
		let headers = { "content-type": "application/json" };
		if (settings.apiKey) {
			headers.authorization = `Bearer ${settings.apiKey}`;
		}
		let body = {
			model: settings.model,
			stream: true,
			messages: [{ role: "system", content: context.system + "\n\n" + context.document }].concat(this.toOpenAIMessages(messages))
		};
		let response = await win.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal
		});
		if (!response.ok) {
			throw this.httpError(response.status, await this.readError(response));
		}

		let stopReason = null;
		let model = null;
		let streamError = null;
		await this.readSSE(response, (event, data) => {
			if (data.trim() === "[DONE]") return;
			let json;
			try {
				json = JSON.parse(data);
			}
			catch (e) {
				return;
			}
			if (json.error) {
				streamError = json.error.message || JSON.stringify(json.error);
				return;
			}
			if (json.model) model = json.model;
			let choice = json.choices?.[0];
			if (!choice) return;
			let content = choice.delta?.content;
			if (typeof content === "string" && content) {
				onText(content);
			}
			if (choice.finish_reason) stopReason = choice.finish_reason;
		});
		if (streamError) {
			throw new Error(`API error: ${streamError}`);
		}
		if (stopReason === "content_filter") {
			stopReason = "refusal";
		}
		return { stopReason, model };
	},

	/**
	 * Send a minimal request to verify the current settings. Used by the settings pane.
	 *
	 * @return {Promise<String>} - Success message; throws on failure
	 */
	async testConnection() {
		let settings = this.getSettings();
		let problem = this.checkSettings(settings);
		if (problem) throw new Error(problem);
		let win = Zotero.getMainWindow();
		if (!win) throw new Error("The main Zotero window is not open.");
		let controller = new win.AbortController();
		let timer = setTimeout(() => controller.abort(), 60000);
		let context = {
			system: "You are a connection test.",
			document: "Reply with the single word OK."
		};
		let text = "";
		try {
			let messages = [{ role: "user", content: "Reply with the single word OK." }];
			let result = settings.provider !== "anthropic"
				? await this.streamOpenAI(settings, context, messages, controller.signal, win, (t) => text += t)
				: await this.streamAnthropic(settings, context, messages, controller.signal, win, (t) => text += t);
			return `Connected to ${result.model || settings.model}. Reply: "${text.trim().slice(0, 60)}"`;
		}
		catch (e) {
			if (controller.signal.aborted) throw new Error("Timed out after 60 seconds.");
			throw e;
		}
		finally {
			clearTimeout(timer);
		}
	},

	// ---------------------------------------------------------------------
	// Notes
	// ---------------------------------------------------------------------

	/**
	 * Save question/answer pairs as a note: a child note when the item has a regular
	 * parent, otherwise a standalone note in the same library.
	 */
	async saveAsNote(item, exchanges) {
		let htmlDoc = new DOMParser().parseFromString(
			"<!DOCTYPE html><html><head></head><body></body></html>", "text/html");
		let body = htmlDoc.body;
		let title = exchanges.length === 1
			? (exchanges[0].question.replace(/\s+/g, " ").slice(0, 100) || "Question about an image")
			: "Chat about " + (this.getFieldSafe(item.isRegularItem() ? item : (item.parentItem || item), "title") || "this item");
		let h1 = htmlDoc.createElement("h1");
		h1.textContent = "AI: " + title;
		body.append(h1);

		exchanges.forEach((ex, i) => {
			if (i > 0) body.append(htmlDoc.createElement("hr"));
			let q = htmlDoc.createElement("p");
			let label = htmlDoc.createElement("strong");
			label.textContent = "Question: ";
			q.append(label);
			AIChatMarkdown.appendText(htmlDoc, q, ex.question
				+ (ex.imageCount ? ` [${ex.imageCount} image${ex.imageCount == 1 ? "" : "s"} attached]` : ""));
			body.append(q);
			AIChatMarkdown.render(htmlDoc, body, ex.answer, { forNote: true });
		});

		let models = [...new Set(exchanges.map((ex) => ex.model).filter(Boolean))];
		let footer = htmlDoc.createElement("p");
		let em = htmlDoc.createElement("em");
		em.textContent = `Generated by ${models.join(", ") || "AI"} via AI Chat for Zotero, ${new Date().toLocaleString()}`;
		footer.append(em);
		body.append(footer);

		let note = new Zotero.Item("note");
		note.libraryID = item.libraryID;
		let parent = item.isRegularItem()
			? item
			: (item.parentItem && item.parentItem.isRegularItem() ? item.parentItem : null);
		if (parent) {
			note.parentID = parent.id;
		}
		note.setNote(body.innerHTML);
		await note.saveTx();
		return note;
	}
};


/**
 * Small Markdown renderer that builds DOM nodes directly (no innerHTML), so model
 * output can never inject markup into Zotero's window. LaTeX maths is taken out of the
 * text first (AIChatMath.extract), so Markdown never sees the _ * | inside formulas.
 */
var AIChatMarkdown = {
	HTML_NS: "http://www.w3.org/1999/xhtml",
	LIST_RE: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
	FENCE_RE: /^\s*(`{3,}|~{3,})\s*([^`\s]*)\s*$/,

	el(doc, tag, className) {
		let e = doc.createElementNS(this.HTML_NS, tag);
		if (className) e.className = className;
		return e;
	},

	fenceCloseRE(fence) {
		return new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
	},

	/**
	 * options.forNote: HTML for a Zotero note (real links, and maths as the note
	 * editor stores it) rather than for the chat
	 */
	render(doc, parent, src, options = {}) {
		let { text, math } = AIChatMath.extract(src);
		this.renderBlocks(doc, parent, text, { ...options, math });
	},

	renderBlocks(doc, parent, src, options) {
		let lines = String(src).split("\n");
		let para = [];
		let flushPara = () => {
			if (!para.length) return;
			let text = para.join("\n");
			para = [];
			// In a note, a displayed equation is a block of its own, as the note editor makes it
			let parts = options.forNote ? this.splitDisplayMath(text, options.math) : [text];
			for (let part of parts) {
				if (typeof part === "number") {
					parent.append(this.noteMath(doc, options.math[part], true));
				}
				else if (part.trim()) {
					let p = this.el(doc, "p");
					this.renderInline(doc, p, part.replace(/^\n+|\n+$/g, ""), options);
					parent.append(p);
				}
			}
		};

		let i = 0;
		while (i < lines.length) {
			let line = lines[i];
			let m;

			// Fenced code block
			if ((m = line.match(this.FENCE_RE))) {
				flushPara();
				let closeRE = this.fenceCloseRE(m[1]);
				let code = [];
				i++;
				while (i < lines.length && !closeRE.test(lines[i])) {
					code.push(lines[i]);
					i++;
				}
				i++;
				let pre = this.el(doc, "pre");
				let codeEl = this.el(doc, "code");
				codeEl.textContent = AIChatMath.restore(code.join("\n"), options.math);
				pre.append(codeEl);
				parent.append(pre);
				continue;
			}

			if (!line.trim()) {
				flushPara();
				i++;
				continue;
			}

			// Heading
			if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
				flushPara();
				let level = options.forNote ? Math.min(m[1].length + 1, 6) : Math.min(m[1].length + 2, 6);
				let h = this.el(doc, "h" + level);
				this.renderInline(doc, h, m[2], options);
				parent.append(h);
				i++;
				continue;
			}

			// Horizontal rule
			if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
				flushPara();
				parent.append(this.el(doc, "hr"));
				i++;
				continue;
			}

			// Table (header row followed by a separator row)
			if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|")
					&& /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
				flushPara();
				let header = this.splitRow(line);
				i += 2;
				let rows = [];
				while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
					rows.push(this.splitRow(lines[i]));
					i++;
				}
				parent.append(this.buildTable(doc, header, rows, options));
				continue;
			}

			// Blockquote
			if (/^\s{0,3}>/.test(line)) {
				flushPara();
				let quoted = [];
				while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
					quoted.push(lines[i].replace(/^\s{0,3}> ?/, ""));
					i++;
				}
				let bq = this.el(doc, "blockquote");
				this.renderBlocks(doc, bq, quoted.join("\n"), options);
				parent.append(bq);
				continue;
			}

			// List
			if (this.LIST_RE.test(line)) {
				flushPara();
				i = this.renderList(doc, parent, lines, i, options);
				continue;
			}

			para.push(line.trim());
			i++;
		}
		flushPara();
	},

	splitRow(line) {
		let s = line.trim();
		if (s.startsWith("|")) s = s.slice(1);
		if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
		return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
	},

	buildTable(doc, header, rows, options) {
		let table = this.el(doc, "table");
		let thead = this.el(doc, "thead");
		let tr = this.el(doc, "tr");
		for (let cell of header) {
			let th = this.el(doc, "th");
			this.renderInline(doc, th, cell, options);
			tr.append(th);
		}
		thead.append(tr);
		table.append(thead);
		let tbody = this.el(doc, "tbody");
		for (let row of rows) {
			let rtr = this.el(doc, "tr");
			for (let j = 0; j < header.length; j++) {
				let td = this.el(doc, "td");
				this.renderInline(doc, td, row[j] || "", options);
				rtr.append(td);
			}
			tbody.append(rtr);
		}
		table.append(tbody);
		if (options.forNote) return table;
		let wrap = this.el(doc, "div", "aichat-table-wrap");
		wrap.append(table);
		return wrap;
	},

	renderList(doc, parent, lines, i, options) {
		let items = [];
		while (i < lines.length) {
			let line = lines[i];
			let m = line.match(this.LIST_RE);
			if (m) {
				items.push({
					indent: m[1].replace(/\t/g, "    ").length,
					ordered: /\d/.test(m[2]),
					start: parseInt(m[2], 10),
					text: m[3]
				});
				i++;
			}
			// Indented continuation of the previous item
			else if (line.trim() && /^\s+/.test(line) && items.length) {
				items[items.length - 1].text += "\n" + line.trim();
				i++;
			}
			// A blank line between items doesn't end the list
			else if (!line.trim() && i + 1 < lines.length && this.LIST_RE.test(lines[i + 1])) {
				i++;
			}
			else {
				break;
			}
		}

		let stack = [];
		let lastLi = null;
		for (let item of items) {
			while (stack.length && item.indent < stack[stack.length - 1].indent) {
				stack.pop();
			}
			let top = stack[stack.length - 1];
			if (!top || item.indent > top.indent) {
				let list = this.el(doc, item.ordered ? "ol" : "ul");
				if (item.ordered && item.start !== 1) list.setAttribute("start", String(item.start));
				(top && lastLi ? lastLi : parent).append(list);
				top = { indent: item.indent, list };
				stack.push(top);
			}
			let li = this.el(doc, "li");
			this.renderInline(doc, li, item.text, options);
			top.list.append(li);
			lastLi = li;
		}
		return i;
	},

	renderInline(doc, parent, text, options = {}) {
		// 1-2: code span, 3-4: [link](url), 5-6: bold, 7-8: italic, 9: bare URL
		let re = /(`+)([\s\S]+?)\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\*\*(?!\s)([^\n]+?)\*\*|__(?!\s)([^\n]+?)__|\*(?![\s*])([^*\n]+?)\*|(?<![\p{L}\p{N}_])_(?![\s_])([^_\n]+?)_(?![\p{L}\p{N}_])|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/gu;
		let last = 0;
		let m;
		while ((m = re.exec(text))) {
			if (m.index > last) this.appendText(doc, parent, text.slice(last, m.index), options);
			if (m[1] !== undefined) {
				let code = this.el(doc, "code");
				code.textContent = AIChatMath.restore(m[2], options.math);
				parent.append(code);
			}
			else if (m[3] !== undefined) {
				parent.append(this.makeLink(doc, m[3], AIChatMath.restore(m[4], options.math), options, true));
			}
			else if (m[5] !== undefined || m[6] !== undefined) {
				let strong = this.el(doc, "strong");
				this.renderInline(doc, strong, m[5] ?? m[6], options);
				parent.append(strong);
			}
			else if (m[7] !== undefined || m[8] !== undefined) {
				let em = this.el(doc, "em");
				this.renderInline(doc, em, m[7] ?? m[8], options);
				parent.append(em);
			}
			else if (m[9] !== undefined) {
				parent.append(this.makeLink(doc, m[9], m[9], options, false));
			}
			last = re.lastIndex;
		}
		if (last < text.length) this.appendText(doc, parent, text.slice(last), options);
	},

	makeLink(doc, label, url, options, parseLabel) {
		let safe = /^https?:\/\//i.test(url);
		if (!safe) {
			// Not a web link; show the label as plain text
			let span = this.el(doc, "span");
			this.appendText(doc, span, label, options);
			return span;
		}
		let a = this.el(doc, "a", options.forNote ? null : "aichat-link");
		if (parseLabel) this.renderInline(doc, a, label, options);
		else a.textContent = label;
		if (options.forNote) {
			a.setAttribute("href", url);
		}
		else {
			// No href: a click would otherwise try to navigate Zotero's window
			a.setAttribute("title", url);
			a.setAttribute("tabindex", "0");
			a.setAttribute("role", "link");
			let open = (event) => {
				event.preventDefault();
				event.stopPropagation();
				Zotero.launchURL(url);
			};
			a.addEventListener("click", open);
			a.addEventListener("keydown", (event) => {
				if (event.key === "Enter") open(event);
			});
		}
		return a;
	},

	/** Text with line breaks, and (from render) the formulas that AIChatMath.extract took out */
	appendText(doc, parent, text, options = {}) {
		let math = options.math;
		text = String(text);
		if (math && !options.forNote) {
			// A displayed equation is a block already; line breaks next to it would add empty lines
			text = text.replace(/\n?(\uE000(\d+)\uE001)\n?/g, (all, mark, k) => (math[k]?.display ? mark : all));
		}
		text.split("\n").forEach((part, idx) => {
			if (idx > 0) parent.append(this.el(doc, "br"));
			if (!part) return;
			if (!math) {
				parent.append(doc.createTextNode(part));
				return;
			}
			let last = 0;
			for (let m of part.matchAll(AIChatMath.PLACEHOLDER_RE)) {
				if (m.index > last) parent.append(doc.createTextNode(part.slice(last, m.index)));
				let entry = math[m[1]];
				if (entry) {
					parent.append(options.forNote ? this.noteMath(doc, entry, false) : this.chatMath(doc, entry));
				}
				last = m.index + m[0].length;
			}
			if (last < part.length) parent.append(doc.createTextNode(part.slice(last)));
		});
	},

	/** A paragraph's text split around its displayed equations (their indexes) */
	splitDisplayMath(text, math) {
		let parts = [];
		let last = 0;
		for (let m of text.matchAll(AIChatMath.PLACEHOLDER_RE)) {
			if (!math[m[1]]?.display) continue;
			parts.push(text.slice(last, m.index), Number(m[1]));
			last = m.index + m[0].length;
		}
		parts.push(text.slice(last));
		return parts;
	},

	/**
	 * A formula as Zotero's note editor stores it, which it then shows rendered: a block
	 * <pre class="math">$$…$$</pre>, or inline <span class="math">$…$</span> (also used
	 * for a displayed equation inside a list item, table cell or heading)
	 */
	noteMath(doc, entry, block) {
		let tex = entry.tex.trim();
		let node = this.el(doc, block ? "pre" : "span", "math");
		node.textContent = block ? `$$${tex}$$` : `$${tex}$`;
		return node;
	},

	/** Rendered chat content as plain text, with each formula as its LaTeX (for copying) */
	plainText(root) {
		let out = "";
		let breakLine = (count) => {
			if (!out) return;
			let have = out.length - out.replace(/\n+$/, "").length;
			if (have < count) out += "\n".repeat(count - have);
		};
		let walk = (node) => {
			if (node.nodeType === 3) {
				out += node.data;
				return;
			}
			if (node.nodeType !== 1 && node.nodeType !== 11) return;
			let tag = node.nodeType === 1 ? node.localName : "";
			if (node.nodeType === 1 && (node.classList.contains("katex-display") || node.classList.contains("katex"))) {
				let tex = (node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || "").trim();
				if (node.classList.contains("katex-display")) {
					breakLine(1);
					out += `$$${tex}$$`;
					breakLine(1);
				}
				else {
					out += `$${tex}$`;
				}
				return;
			}
			if (tag === "br") {
				out += "\n";
				return;
			}
			let lines = /^(p|h[1-6]|pre|blockquote|table|ul|ol)$/.test(tag) ? 2 : /^(li|tr|div)$/.test(tag) ? 1 : 0;
			breakLine(lines);
			for (let child of node.childNodes) walk(child);
			if (tag === "td" || tag === "th") out += "\t";
			breakLine(lines);
		};
		walk(root);
		return out.replace(/\t+\n/g, "\n").trim();
	},

	chatMath(doc, entry) {
		let result = AIChatMath.render(entry.tex, entry.display);
		if (result.node) return doc.importNode(result.node, true);
		// Not valid LaTeX (or the renderer is missing): show what the model wrote
		let code = this.el(doc, "code", "aichat-math-error");
		code.textContent = entry.raw;
		code.setAttribute("title", "This formula couldn't be shown: " + result.error);
		return code;
	}
};


/**
 * LaTeX maths in answers, drawn by the bundled KaTeX (content/katex).
 *
 * extract() replaces each formula with a placeholder before the Markdown is parsed;
 * the renderer turns the placeholders back into formulas: KaTeX's output in the chat,
 * or the <span class="math"> / <pre class="math"> markup of Zotero's notes.
 *
 * Recognised: \( \) and $ $ inline; \[ \], $$ $$ and \begin{equation|align|gather|alignat}
 * displayed. A $ only opens a formula when a non-space follows it and only closes one
 * after a non-space and before a non-digit, so prices like "$5 and $10" stay text.
 * Nothing in code spans or code blocks is touched, \$ is a dollar sign, and a formula
 * never runs across a blank line.
 */
var AIChatMath = {
	// Marks a formula's place in the text: \uE000<index>\uE001 (private-use characters)
	PLACEHOLDER_RE: /\uE000(\d+)\uE001/g,
	ENV_RE: /^\\begin\{((?:equation|align|gather|alignat)\*?)\}/,
	MATHML_NS: "http://www.w3.org/1998/Math/MathML",
	SVG_NS: "http://www.w3.org/2000/svg",
	CACHE_SIZE: 300,

	katex: undefined,
	parser: null,
	// "D"/"I" + LaTeX -> { node } or { error }, most recently used last
	cache: new Map(),

	reset() {
		this.katex = undefined;
		this.parser = null;
		this.cache.clear();
	},

	/** Returns { text, math: [{ tex, display, raw }] } */
	extract(src) {
		src = String(src ?? "").replace(/\r\n?/g, "\n").replace(/[\uE000\uE001]/g, "\uFFFD");
		let math = [];
		let out = "";
		let n = src.length;
		let i = 0;
		let add = (tex, display, raw) => {
			out += "\uE000" + math.length + "\uE001";
			math.push({ tex, display, raw });
		};

		while (i < n) {
			let c = src[i];

			// Fenced code block, found the same way the renderer finds it: copied as is
			if (i === 0 || src[i - 1] === "\n") {
				let end = this.lineEnd(src, i);
				let fence = src.slice(i, end).match(AIChatMarkdown.FENCE_RE);
				if (fence) {
					let closeRE = AIChatMarkdown.fenceCloseRE(fence[1]);
					let j = end;
					while (j < n) {
						let next = this.lineEnd(src, j + 1);
						let closed = closeRE.test(src.slice(j + 1, next));
						j = next;
						if (closed) break;
					}
					out += src.slice(i, j);
					i = j;
					continue;
				}
			}

			// Code span: copied as is
			if (c === "`") {
				let run = this.runLength(src, i, "`");
				let close = this.findBackticks(src, i + run, run);
				let j = close >= 0 ? close + run : i + run;
				out += src.slice(i, j);
				i = j;
				continue;
			}

			if (c === "\\") {
				let d = src[i + 1];
				if (d === "$") {
					out += "$";
					i += 2;
					continue;
				}
				if (d === "\\") {
					out += "\\\\";
					i += 2;
					continue;
				}
				if (d === "(" || d === "[") {
					let closer = d === "(" ? "\\)" : "\\]";
					let end = this.findClose(src, i + 2, closer);
					if (end >= 0) {
						let tex = src.slice(i + 2, end);
						// "\[1\]" or "\[2, 3\]" is a citation with escaped brackets, not maths
						if (d === "[" && /^[\s\d,;–-]*$/.test(tex)) {
							out += "[" + tex + "]";
							i = end + 2;
							continue;
						}
						if (tex.trim()) {
							add(tex, d === "[", src.slice(i, end + 2));
							i = end + 2;
							continue;
						}
					}
				}
				let env = src.startsWith("\\begin{", i) && src.slice(i, i + 40).match(this.ENV_RE);
				if (env) {
					let endTag = "\\end{" + env[1] + "}";
					let end = this.findClose(src, i + env[0].length, endTag);
					if (end >= 0) {
						let raw = src.slice(i, end + endTag.length);
						add(raw, true, raw);
						i = end + endTag.length;
						continue;
					}
				}
				out += c;
				i++;
				continue;
			}

			if (c === "$") {
				if (src[i + 1] === "$") {
					let end = this.findClose(src, i + 2, "$$");
					if (end >= 0 && src.slice(i + 2, end).trim()) {
						add(src.slice(i + 2, end), true, src.slice(i, end + 2));
						i = end + 2;
						continue;
					}
					out += "$$";
					i += 2;
					continue;
				}
				if (i + 1 < n && !/\s/.test(src[i + 1])) {
					let end = this.findDollar(src, i + 1);
					if (end >= 0) {
						add(src.slice(i + 1, end), false, src.slice(i, end + 1));
						i = end + 1;
						continue;
					}
				}
			}

			out += c;
			i++;
		}
		return { text: out, math };
	},

	lineEnd(src, i) {
		let end = src.indexOf("\n", i);
		return end < 0 ? src.length : end;
	},

	runLength(src, i, ch) {
		let j = i;
		while (src[j] === ch) j++;
		return j - i;
	},

	// Is there a blank line starting at the newline at i?
	blankLineAt(src, i) {
		if (src[i] !== "\n") return false;
		let j = i + 1;
		while (src[j] === " " || src[j] === "\t") j++;
		return j >= src.length || src[j] === "\n";
	},

	/** Index of the next run of exactly `run` backticks in the same paragraph, or -1 */
	findBackticks(src, from, run) {
		let k = from;
		while (k < src.length) {
			if (this.blankLineAt(src, k)) return -1;
			if (src[k] === "`") {
				let len = this.runLength(src, k, "`");
				if (len === run) return k;
				k += len;
			}
			else {
				k++;
			}
		}
		return -1;
	},

	/** Index of `closer` (skipping escaped characters) before the next blank line, or -1 */
	findClose(src, from, closer) {
		let k = from;
		while (k < src.length) {
			if (src.startsWith(closer, k)) return k;
			if (this.blankLineAt(src, k)) return -1;
			k += src[k] === "\\" ? 2 : 1;
		}
		return -1;
	},

	/** Index of the $ that closes an inline formula, or -1 if the first $ can't close it */
	findDollar(src, from) {
		let k = from;
		while (k < src.length) {
			let c = src[k];
			if (c === "\\") {
				k += 2;
				continue;
			}
			if (this.blankLineAt(src, k)) return -1;
			if (c === "$") {
				return !/\s/.test(src[k - 1]) && !/\d/.test(src[k + 1] || "") ? k : -1;
			}
			k++;
		}
		return -1;
	},

	/** Puts the original text back in place of placeholders (in code, and in link URLs) */
	restore(text, math) {
		if (!math?.length) return text;
		return text.replace(this.PLACEHOLDER_RE, (all, k) => math[k]?.raw ?? "");
	},

	load() {
		if (this.katex === undefined) {
			this.katex = null;
			try {
				// KaTeX's UMD wrapper puts itself on `self`
				let scope = {};
				scope.self = scope;
				Services.scriptloader.loadSubScript(AIChat.rootURI + "content/katex/katex.min.js", scope);
				this.katex = scope.katex || null;
				if (!this.katex) throw new Error("KaTeX did not load");
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return this.katex;
	},

	/**
	 * Renders a formula. Returns { node } (a node of a private document, to be imported)
	 * or { error }. Results are cached: a streamed answer is redrawn many times.
	 */
	render(tex, display) {
		let key = (display ? "D" : "I") + tex;
		let result = this.cache.get(key);
		if (result) {
			this.cache.delete(key);
			this.cache.set(key, result);
			return result;
		}
		let katex = this.load();
		if (!katex) {
			result = { error: "the maths renderer couldn't be loaded" };
		}
		else {
			try {
				let html = katex.renderToString(tex, {
					displayMode: display,
					throwOnError: true,
					// No \href, \includegraphics, \htmlClass and the like
					trust: false,
					strict: "ignore",
					maxExpand: 500,
					maxSize: 50
				});
				this.parser ||= new DOMParser();
				let doc = this.parser.parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, "text/html");
				let node = doc.body.firstElementChild;
				if (!node || !this.clean(node)) throw new Error("unexpected output");
				result = { node };
			}
			catch (e) {
				result = { error: String(e?.message || e).replace(/^KaTeX parse error: /, "") };
			}
		}
		this.cache.set(key, result);
		while (this.cache.size > this.CACHE_SIZE) {
			this.cache.delete(this.cache.keys().next().value);
		}
		return result;
	},

	/**
	 * Keeps only what KaTeX makes (spans, MathML, and SVG lines and paths for things like
	 * square roots and arrows) and drops anything that could run code or load a URL.
	 * KaTeX doesn't output any of that with trust: false; this is a second line of defence
	 * because the formulas come from the model. Returns false if the root itself is unsafe.
	 */
	clean(root) {
		let allowed = (el) => {
			if (el.namespaceURI === this.MATHML_NS) return el.localName !== "maction" && el.localName !== "annotation-xml";
			if (el.namespaceURI === this.SVG_NS) return ["svg", "path", "line"].includes(el.localName);
			return el.localName === "span";
		};
		if (!allowed(root)) return false;
		let stack = [root];
		while (stack.length) {
			let el = stack.pop();
			for (let attr of [...el.attributes]) {
				let name = attr.name.toLowerCase();
				if (name.startsWith("on") || ["href", "src", "srcset", "action", "formaction"].includes(name)
						|| (name.includes(":") && !name.startsWith("xmlns"))
						|| (name === "style" && /url\s*\(|expression|binding|@import/i.test(attr.value))) {
					el.removeAttribute(attr.name);
				}
			}
			for (let child of [...el.children]) {
				if (allowed(child)) stack.push(child);
				else child.remove();
			}
		}
		return true;
	},

	/** KaTeX's stylesheet, adjusted for the plugin: bundled .woff2 fonts, no rule on <body> */
	adaptCSS(css, fontBase) {
		let base = fontBase.replace(/["\\]/g, "\\$&");
		return css
			.replace(/,url\(fonts\/[^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "")
			.replace(/url\(fonts\/([^)]+)\)/g, `url("${base}$1")`)
			// Equation numbers count per chat rather than on Zotero's window
			.replace(/(^|\})body\{/g, "$1.aichat-root{");
	}
};


/**
 * The chat UI inside one item pane section. One instance per section body; it shows
 * the conversation of whichever item is currently selected.
 *
 * Layout: a header (chat history menu, New chat, Save as note, Settings), the messages
 * (or the history list in their place), the composer (attached images, text box, crop,
 * paste, model menu, Send) and a one-line status under it.
 *
 * Assigned with `var` because this script is re-run in the same scope when the plugin
 * is disabled and re-enabled, and a top-level `class` declaration can't be redeclared.
 */
var AIChatView = class {
	constructor(plugin, body, doc) {
		this.plugin = plugin;
		this.body = body;
		this.doc = doc;
		this.win = doc.defaultView;
		this.item = null;
		this.conv = null;
		this.rendered = null;
		this.historyOpen = false;
		this.historyToken = null;
		this.renderedHistoryVersion = -1;
		this.noteText = "";
		this.noteIsError = false;
		this.flashTimers = new WeakMap();
		this.listener = () => this.update();
		this.build();
	}

	el(tag, className, text) {
		let e = this.doc.createElementNS(this.plugin.HTML_NS, tag);
		if (className) e.className = className;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	icon(name) {
		let NS = this.plugin.SVG_NS;
		let svg = this.doc.createElementNS(NS, "svg");
		svg.setAttribute("class", "aichat-icon");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("aria-hidden", "true");
		for (let shape of this.plugin.ICONS[name] || []) {
			let [tag, attrs] = typeof shape === "string" ? ["path", { d: shape }] : shape;
			let node = this.doc.createElementNS(NS, tag);
			for (let [attr, value] of Object.entries(attrs)) node.setAttribute(attr, String(value));
			svg.append(node);
		}
		return svg;
	}

	button(label, className, onClick, title) {
		let b = this.el("button", "aichat-button " + (className || ""), label);
		b.type = "button";
		if (title) b.title = title;
		b.addEventListener("click", onClick);
		return b;
	}

	iconButton(iconName, label, className, onClick) {
		let b = this.el("button", "aichat-icon-button" + (className ? " " + className : ""));
		b.type = "button";
		this.setLabel(b, label);
		this.setIcon(b, iconName);
		b.addEventListener("click", onClick);
		return b;
	}

	setLabel(button, label) {
		button.title = label;
		button.setAttribute("aria-label", label);
	}

	setIcon(button, name) {
		if (button.dataset.icon === name) return;
		button.dataset.icon = name;
		let icon = this.icon(name);
		let old = button.querySelector(".aichat-icon");
		if (old) old.replaceWith(icon);
		else button.append(icon);
	}

	// Briefly show a check mark and a new label on an icon button, e.g. "Copied"
	flash(button, label) {
		if (!button.dataset.restoreIcon) {
			button.dataset.restoreIcon = button.dataset.icon;
			button.dataset.restoreLabel = button.title;
		}
		this.setIcon(button, "check");
		this.setLabel(button, label);
		button.classList.add("aichat-flash");
		this.win.clearTimeout(this.flashTimers.get(button));
		this.flashTimers.set(button, this.win.setTimeout(() => {
			this.setIcon(button, button.dataset.restoreIcon);
			this.setLabel(button, button.dataset.restoreLabel);
			delete button.dataset.restoreIcon;
			delete button.dataset.restoreLabel;
			button.classList.remove("aichat-flash");
		}, 1500));
	}

	build() {
		let root = this.el("div", "aichat-root");

		let header = this.el("div", "aichat-header");
		this.historyButton = this.el("button", "aichat-history-toggle");
		this.historyButton.type = "button";
		this.historyButton.title = "Chat history: earlier chats about this item";
		this.historyButton.setAttribute("aria-expanded", "false");
		this.chatTitle = this.el("span", "aichat-chat-title", "New chat");
		this.historyButton.append(this.icon("history"), this.chatTitle, this.icon("chevron"));
		this.historyButton.addEventListener("click", () => this.toggleHistory());
		this.newChatButton = this.iconButton("plus", "New chat", "aichat-new-chat", () => this.newChat());
		this.saveChatButton = this.iconButton("note", "Save this chat as a note", "aichat-save-chat", () => this.saveChat());
		let settingsButton = this.iconButton("settings", "AI Chat settings", "aichat-settings", () => this.plugin.openSettings());
		header.append(this.historyButton, this.newChatButton, this.saveChatButton, settingsButton);

		this.historyEl = this.el("div", "aichat-history");
		this.historyEl.hidden = true;
		this.messagesEl = this.el("div", "aichat-messages");
		this.messagesEl.addEventListener("copy", (event) => this.onCopy(event));

		let composer = this.el("div", "aichat-composer");
		this.tray = this.el("div", "aichat-tray");
		this.tray.hidden = true;
		this.input = this.el("textarea", "aichat-input");
		this.input.rows = 2;
		this.input.placeholder = "Ask about this item…";
		this.input.setAttribute("aria-label", "Your question");
		this.input.addEventListener("paste", (event) => this.onPaste(event));
		this.input.addEventListener("keydown", (event) => this.onPasteKey(event));
		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				this.submit();
			}
		});
		this.input.addEventListener("input", () => {
			if (this.conv) this.conv.draft = this.input.value;
			this.autoSize();
			this.updateSendButton();
		});

		let bar = this.el("div", "aichat-composer-bar");
		let pasteKey = Zotero.isMac ? "Cmd+V" : "Ctrl+V";
		this.cropButton = this.iconButton("crop",
			"Crop a figure, table or equation from the screen (zoom in first for a sharper image)",
			"aichat-crop", () => this.cropFromScreen());
		this.pasteButton = this.iconButton("image",
			`Paste an image from the clipboard (or press ${pasteKey} in the text box)`,
			"aichat-paste", () => this.pasteClipboardImage());
		this.modelSelect = this.el("select", "aichat-model-select");
		this.modelSelect.title = "Model for new questions";
		this.modelSelect.addEventListener("change", () => this.chooseModel());
		this.sendButton = this.iconButton("send", "Send (Enter)", "aichat-send", () => {
			if (this.conv?.busy) this.conv.abort?.abort();
			else this.submit();
		});
		let modelWrap = this.el("span", "aichat-model-wrap");
		modelWrap.append(this.modelSelect, this.icon("chevron"));
		bar.append(this.cropButton, this.pasteButton, modelWrap, this.sendButton);
		composer.append(this.tray, this.input, bar);
		// A click on the composer's empty space goes to the text box
		composer.addEventListener("mousedown", (event) => {
			if (event.target === composer || event.target === bar) {
				event.preventDefault();
				this.input.focus();
			}
		});

		this.footer = this.el("div", "aichat-context");

		root.append(header, this.historyEl, this.messagesEl, composer, this.footer);
		this.body.replaceChildren(root);
	}

	show(item) {
		if (this.conv && this.item?.id === item.id) {
			this.renderAll();
			return;
		}
		let old = this.conv;
		if (old) {
			old.listeners.delete(this.listener);
			// Idle, saved chats reload from the history, so browsing doesn't pile them up in memory
			if (this.plugin.canForget(old)) {
				this.plugin.conversations.delete(old.itemID);
			}
		}
		this.item = item;
		this.conv = this.plugin.getConversation(item);
		this.conv.listeners.add(this.listener);
		this.input.value = this.conv.draft || "";
		this.noteText = "";
		this.toggleHistory(false);
		this.renderAll();
		this.autoSize();
		this.plugin.restoreChat(this.conv);
	}

	destroy() {
		if (this.conv) this.conv.listeners.delete(this.listener);
		this.win.clearTimeout(this.noteTimer);
		this.conv = null;
		this.item = null;
		this.body.replaceChildren();
	}

	submit() {
		if (!this.conv || this.conv.busy) return;
		let text = this.input.value.trim();
		if (!text && !this.conv.pendingImages.length) return;
		this.input.value = "";
		this.conv.draft = "";
		this.autoSize();
		this.toggleHistory(false);
		this.plugin.send(this.conv, this.item, this.win, text, this.takeImages());
	}

	ask(text) {
		if (!this.conv || this.conv.busy) return;
		this.toggleHistory(false);
		this.plugin.send(this.conv, this.item, this.win, text, this.takeImages());
	}

	retry(index) {
		if (!this.conv || this.conv.busy) return;
		this.plugin.retry(this.conv, this.item, this.win, index);
	}

	takeImages() {
		let images = this.conv.pendingImages;
		this.conv.pendingImages = [];
		return images;
	}

	newChat() {
		if (this.conv) this.plugin.clearConversation(this.conv);
		this.toggleHistory(false);
		this.input.focus();
	}

	// Grow the text box with its content, up to about a third of the window
	autoSize() {
		let input = this.input;
		input.style.height = "";
		let natural = input.scrollHeight;
		// Not laid out yet (collapsed section)
		if (!natural) return;
		let max = Math.round(Math.max(96, this.win.innerHeight * 0.3));
		input.style.height = Math.min(natural, max) + "px";
		input.style.overflowY = natural > max ? "auto" : "hidden";
	}

	// A short message under the composer, e.g. why a paste didn't work. Clears itself.
	setNote(text, isError) {
		this.noteText = text || "";
		this.noteIsError = !!isError;
		this.win.clearTimeout(this.noteTimer);
		if (text) {
			this.noteTimer = this.win.setTimeout(() => this.setNote(), 6000);
		}
		this.updateFooter();
	}

	updateFooter() {
		let text;
		if (this.noteText) {
			text = this.noteText;
		}
		else if (this.conv?.context) {
			text = "Context: " + this.conv.context.summary;
		}
		else {
			text = "Enter to send · Shift+Enter for a new line";
		}
		if (this.footer.textContent !== text) this.footer.textContent = text;
		this.footer.classList.toggle("aichat-error-text", !!this.noteText && this.noteIsError);
	}

	// -------------------------------------------------------------------
	// Chat history list
	// -------------------------------------------------------------------

	toggleHistory(open = !this.historyOpen) {
		if (open && !this.plugin.historyEnabled()) {
			this.setNote("Chat history is turned off in AI Chat settings.", true);
			return;
		}
		if (open === this.historyOpen) return;
		this.historyOpen = open;
		this.historyEl.hidden = !open;
		this.messagesEl.hidden = open;
		this.historyButton.classList.toggle("aichat-open", open);
		this.historyButton.setAttribute("aria-expanded", String(open));
		if (open) {
			this.historyEl.replaceChildren(this.el("div", "aichat-history-head", "Loading…"));
			this.renderHistory();
		}
		else {
			this.historyToken = null;
			this.historyEl.replaceChildren();
			this.scrollToBottom();
		}
		this.updateHeader();
	}

	async renderHistory() {
		let conv = this.conv;
		if (!conv) return;
		let token = {};
		this.historyToken = token;
		this.renderedHistoryVersion = conv.historyVersion;
		let chats = [];
		try {
			chats = await this.plugin.listChats(conv);
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (this.historyToken !== token || this.conv !== conv) return;

		let nodes = [this.el("div", "aichat-history-head", "Chats about this item")];
		if (!chats.length) {
			nodes.push(this.el("div", "aichat-history-empty",
				"No saved chats yet. A chat is saved here after its first answer."));
		}
		let list = this.el("div", "aichat-history-list");
		for (let chat of chats) {
			let row = this.el("div", "aichat-history-row");
			row.dataset.chatId = chat.id;
			let current = chat.id === conv.chatID;
			if (current) row.classList.add("aichat-current");
			let open = this.el("button", "aichat-history-open");
			open.type = "button";
			open.title = current ? "This chat is open" : "Open this chat";
			// Switching chats mid-answer would leave the answer with nowhere to go
			open.disabled = conv.busy && !current;
			open.append(
				this.el("span", "aichat-history-title", chat.title),
				this.el("span", "aichat-history-meta",
					`${chat.count} question${chat.count == 1 ? "" : "s"} · ${this.formatDate(chat.updated)}`)
			);
			open.addEventListener("click", () => this.openChat(chat.id));
			let del = this.iconButton("trash", "Delete this chat", "aichat-history-delete", () => this.deleteChat(del, chat.id));
			row.append(open, del);
			list.append(row);
		}
		if (chats.length) nodes.push(list);
		this.historyEl.replaceChildren(...nodes);
	}

	formatDate(ms) {
		let date = new Date(ms);
		let now = new Date();
		let time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
		if (date.toDateString() === now.toDateString()) return "today " + time;
		let yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
		if (date.toDateString() === yesterday.toDateString()) return "yesterday " + time;
		let options = { day: "numeric", month: "short" };
		if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
		return date.toLocaleDateString([], options);
	}

	async openChat(chatID) {
		let conv = this.conv;
		if (!conv) return;
		let opened = await this.plugin.openChat(conv, chatID);
		if (this.conv !== conv) return;
		if (!opened) {
			this.setNote(conv.busy ? "Wait for the answer to finish first." : "Couldn't open that chat.", true);
			return;
		}
		this.toggleHistory(false);
		this.input.focus();
	}

	// The first click arms the button; a second click within a few seconds deletes
	async deleteChat(button, chatID) {
		if (!button.classList.contains("aichat-confirm")) {
			button.classList.add("aichat-confirm");
			button.replaceChildren(this.doc.createTextNode("Delete"));
			delete button.dataset.icon;
			this.setLabel(button, "Click again to delete this chat");
			this.win.setTimeout(() => {
				if (!button.isConnected || !button.classList.contains("aichat-confirm")) return;
				button.classList.remove("aichat-confirm");
				button.replaceChildren();
				this.setIcon(button, "trash");
				this.setLabel(button, "Delete this chat");
			}, 3000);
			return;
		}
		button.disabled = true;
		await this.plugin.deleteChat(this.conv, chatID);
	}

	// -------------------------------------------------------------------
	// Images
	// -------------------------------------------------------------------

	isPasteShortcut(event) {
		let accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
		return (accel && !event.altKey && event.key?.toLowerCase() === "v")
			|| (event.shiftKey && !accel && event.key === "Insert");
	}

	// With only an image on the clipboard, Zotero's text boxes ignore Ctrl+V entirely, so
	// catch the shortcut and read the image ourselves. With text on the clipboard, the
	// normal paste runs (and onPaste picks up any images that come along with it).
	onPasteKey(event) {
		if (!this.isPasteShortcut(event)) return;
		try {
			this.plugin.logClipboard("Ctrl+V");
			if (this.plugin.clipboardHasText() || !this.plugin.clipboardHasImage()) return;
		}
		catch (e) {
			Zotero.logError(e);
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.pasteClipboardImage();
	}

	async pasteClipboardImage() {
		try {
			this.plugin.logClipboard("Paste image");
			if (!this.plugin.clipboardHasImage()) {
				this.setNote("There's no image on the clipboard. Copy one first, e.g. with a screenshot tool.", true);
				return;
			}
			let blob = await this.plugin.readClipboardImage(this.win);
			if (!blob) {
				this.setNote("Couldn't read the image on the clipboard.", true);
				return;
			}
			await this.addImage(blob);
		}
		catch (e) {
			Zotero.logError(e);
			this.setNote("Couldn't paste the image: " + (e.message || e), true);
		}
	}

	/**
	 * Copying selected text that includes formulas: by default each formula would come out
	 * twice (KaTeX draws it, and keeps a hidden MathML copy) and unreadable, so copy each
	 * as its LaTeX instead: $…$, or $$…$$ for a displayed equation
	 */
	onCopy(event) {
		let sel = this.win.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount || !event.clipboardData) return;
		let range = sel.getRangeAt(0).cloneRange();
		let formula = (node) => {
			let el = node.nodeType === 1 ? node : node.parentElement;
			return el?.closest(".katex-display") || el?.closest(".katex");
		};
		// A selection that starts or ends inside a formula takes the whole formula
		let start = formula(range.startContainer);
		let end = formula(range.endContainer);
		if (start) range.setStartBefore(start);
		if (end) range.setEndAfter(end);
		let fragment = range.cloneContents();
		if (!fragment.querySelector(".katex")) return; // ordinary text: the default copy is fine
		event.clipboardData.setData("text/plain", AIChatMarkdown.plainText(fragment));
		event.preventDefault();
	}

	onPaste(event) {
		let files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
		if (!files.length) return; // ordinary text paste
		event.preventDefault();
		(async () => {
			for (let file of files) await this.addImage(file);
		})();
	}

	async addImage(source) {
		let conv = this.conv;
		if (!conv) return;
		let max = this.plugin.MAX_IMAGES;
		if (conv.pendingImages.length >= max) {
			this.setNote(`You can attach up to ${max} images per message.`, true);
			return;
		}
		try {
			let image = await this.plugin.prepareImage(this.win, source);
			if (conv.pendingImages.length >= max) {
				this.setNote(`You can attach up to ${max} images per message.`, true);
				return;
			}
			conv.pendingImages.push(image);
			this.plugin.notify(conv);
		}
		catch (e) {
			this.setNote(e.message || String(e), true);
		}
	}

	removeImage(id) {
		if (!this.conv) return;
		this.conv.pendingImages = this.conv.pendingImages.filter((i) => i.id !== id);
		this.plugin.notify(this.conv);
	}

	renderTray() {
		let images = this.conv?.pendingImages || [];
		let key = images.map((i) => i.id).join(",");
		if (key === this.trayKey) return;
		this.trayKey = key;
		this.tray.replaceChildren();
		this.tray.hidden = !images.length;
		for (let image of images) {
			let item = this.el("div", "aichat-tray-item");
			let thumb = this.el("img", "aichat-thumb");
			thumb.src = image.dataURL;
			thumb.alt = "Attached image";
			let remove = this.iconButton("close", "Remove this image", "aichat-remove", () => this.removeImage(image.id));
			item.append(thumb, remove);
			this.tray.append(item);
		}
	}

	async cropFromScreen() {
		if (this.cropping || !this.conv) return;
		this.cropping = true;
		this.cropButton.disabled = true;
		try {
			let rect = await this.selectRegion();
			if (!rect) return;
			// Let the dimming overlay disappear from the screen before capturing
			await new Promise((resolve) => this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(resolve)));
			let snapshot = await this.win.browsingContext.currentWindowGlobal.drawSnapshot(
				new this.win.DOMRect(rect.x, rect.y, rect.width, rect.height),
				this.win.devicePixelRatio || 1,
				"white"
			);
			await this.addImage(snapshot);
		}
		catch (e) {
			Zotero.logError(e);
			this.setNote("Couldn't capture that area: " + (e.message || e), true);
		}
		finally {
			this.cropping = false;
			this.cropButton.disabled = false;
		}
	}

	/**
	 * Dim the window and let the user drag a rectangle. Resolves with {x, y, width, height}
	 * in window coordinates, or null if cancelled (Esc, or a drag that is too small).
	 */
	selectRegion() {
		return new Promise((resolve) => {
			let doc = this.doc;
			let win = this.win;
			let overlay = this.el("div", "aichat-crop-overlay");
			let box = this.el("div", "aichat-crop-box");
			box.hidden = true;
			overlay.append(this.el("div", "aichat-crop-hint", "Drag to select an area. Press Esc to cancel."), box);
			doc.documentElement.append(overlay);

			let start = null;
			let current = null;
			let finish = (rect) => {
				win.removeEventListener("keydown", onKey, true);
				overlay.remove();
				resolve(rect);
			};
			let onKey = (event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				finish(null);
			};
			let toRect = (a, b) => {
				let x1 = Math.max(0, Math.min(a.x, b.x));
				let y1 = Math.max(0, Math.min(a.y, b.y));
				let x2 = Math.min(win.innerWidth, Math.max(a.x, b.x));
				let y2 = Math.min(win.innerHeight, Math.max(a.y, b.y));
				return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
			};
			win.addEventListener("keydown", onKey, true);
			overlay.addEventListener("pointerdown", (event) => {
				event.preventDefault();
				start = current = { x: event.clientX, y: event.clientY };
				try {
					overlay.setPointerCapture(event.pointerId);
				}
				catch (e) {}
			});
			overlay.addEventListener("pointermove", (event) => {
				if (!start) return;
				current = { x: event.clientX, y: event.clientY };
				let r = toRect(start, current);
				box.hidden = false;
				box.style.left = r.x + "px";
				box.style.top = r.y + "px";
				box.style.width = r.width + "px";
				box.style.height = r.height + "px";
			});
			overlay.addEventListener("pointerup", (event) => {
				if (!start) return;
				let r = toRect(start, { x: event.clientX, y: event.clientY });
				start = null;
				finish(r.width >= 8 && r.height >= 8 ? r : null);
			});
		});
	}

	// -------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------

	isNearBottom() {
		let el = this.messagesEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
	}

	scrollToBottom() {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	update() {
		let conv = this.conv;
		if (!conv) return;
		let state = this.rendered;
		if (!state || state.count !== conv.messages.length || state.chatID !== conv.chatID
				|| state.restoring !== !!conv.restoring) {
			this.renderAll();
		}
		else {
			// Only the last answer changes while streaming
			let stick = this.isNearBottom();
			let last = conv.messages.length - 1;
			let node = this.messagesEl.lastElementChild;
			if (last >= 0 && node) {
				node.replaceWith(this.renderMessage(conv.messages[last], last));
			}
			this.updateControls();
			if (stick) this.scrollToBottom();
		}
		if (this.historyOpen && conv.historyVersion !== this.renderedHistoryVersion) {
			this.renderHistory();
		}
	}

	renderAll() {
		let conv = this.conv;
		if (!conv) return;
		this.messagesEl.replaceChildren();
		if (conv.messages.length) {
			conv.messages.forEach((msg, index) => {
				this.messagesEl.append(this.renderMessage(msg, index));
			});
		}
		else if (conv.restoring) {
			// Reading the saved chat; brief, so show nothing rather than flash the suggestions
			this.messagesEl.append(this.el("div", "aichat-loading"));
		}
		else {
			this.messagesEl.append(this.renderEmpty());
		}
		this.rendered = { count: conv.messages.length, chatID: conv.chatID, restoring: !!conv.restoring };
		this.updateControls();
		this.scrollToBottom();
	}

	updateControls() {
		let conv = this.conv;
		let busy = !!conv?.busy;
		this.setIcon(this.sendButton, busy ? "stop" : "send");
		this.setLabel(this.sendButton, busy ? "Stop" : "Send (Enter)");
		this.sendButton.classList.toggle("aichat-stop", busy);
		this.updateSendButton();
		this.newChatButton.disabled = !conv?.messages.length;
		if (!this.saveChatButton.classList.contains("aichat-flash")) {
			this.saveChatButton.disabled = busy || !this.getExchanges().length;
		}
		if (this.historyOpen && !this.plugin.historyEnabled()) {
			this.toggleHistory(false);
		}
		this.updateHeader();
		this.updateFooter();
		this.renderTray();
		this.updateModelSelect();
	}

	updateSendButton() {
		let conv = this.conv;
		this.sendButton.disabled = !conv
			|| (!conv.busy && !this.input.value.trim() && !conv.pendingImages.length);
	}

	updateHeader() {
		let title = this.historyOpen ? "Chat history" : this.plugin.chatTitle(this.conv?.messages || []);
		if (this.chatTitle.textContent !== title) this.chatTitle.textContent = title;
	}

	chooseModel() {
		let model = this.modelSelect.value;
		if (!model) return;
		this.plugin.setModel(this.plugin.getSettings().provider, model);
		this.updateModelSelect();
	}

	// Lists the favorites of the active provider, plus the current model if it isn't one of them
	updateModelSelect() {
		let settings = this.plugin.getSettings();
		let favorites = this.plugin.getFavoriteModels(settings.provider);
		let models = settings.model && !favorites.includes(settings.model)
			? [settings.model, ...favorites]
			: favorites;

		let key = settings.provider + "\n" + models.join("\n");
		if (key !== this.modelKey) {
			this.modelKey = key;
			this.modelSelect.replaceChildren();
			if (!models.length) {
				let none = this.el("option", "", "Set a model in Settings");
				none.value = "";
				this.modelSelect.append(none);
			}
			for (let model of models) {
				let option = this.el("option", "", model);
				option.value = model;
				this.modelSelect.append(option);
			}
		}
		this.modelSelect.value = settings.model || "";
		// Changing the model mid-answer wouldn't affect that answer, so keep it fixed while busy
		this.modelSelect.disabled = !!this.conv?.busy || !models.length;
	}

	renderEmpty() {
		let box = this.el("div", "aichat-empty");
		box.append(
			this.el("div", "aichat-empty-title", "Ask anything about this item"),
			this.el("div", "aichat-empty-sub",
				"Answers use its full text, metadata and your annotations. Crop or paste a figure to ask about it.")
		);
		let chips = this.el("div", "aichat-suggestions");
		for (let suggestion of this.plugin.SUGGESTIONS) {
			chips.append(this.button(suggestion, "aichat-chip", () => this.ask(suggestion)));
		}
		box.append(chips);
		return box;
	}

	renderMessage(msg, index) {
		let conv = this.conv;
		if (msg.role === "user") {
			let wrap = this.el("div", "aichat-msg aichat-user");
			if (msg.images?.length) {
				let row = this.el("div", "aichat-thumbs");
				for (let image of msg.images) {
					let thumb = this.el("img", "aichat-thumb");
					thumb.src = image.dataURL;
					thumb.alt = "Attached image";
					row.append(thumb);
				}
				wrap.append(row);
			}
			if (msg.text) wrap.append(this.el("div", "aichat-bubble", msg.text));
			return wrap;
		}

		let wrap = this.el("div", "aichat-msg aichat-assistant");
		if (msg.text) {
			let content = this.el("div", "aichat-answer aichat-markdown");
			AIChatMarkdown.render(this.doc, content, msg.text);
			wrap.append(content);
		}
		if (msg.status === "streaming") {
			wrap.append(this.el("div", "aichat-status aichat-typing", msg.phase || "Writing…"));
		}
		else if (msg.status === "stopped") {
			wrap.append(this.el("div", "aichat-status", "Stopped."));
		}
		else if (msg.status === "error" || msg.status === "refused") {
			let err = this.el("div", "aichat-error");
			err.append(this.el("div", "aichat-error-text-body", msg.error || "Something went wrong."));
			let buttons = [];
			if (index === conv.messages.length - 1 && !conv.busy) {
				buttons.push(this.button("Retry", "aichat-retry", () => this.retry(index), "Ask this question again"));
			}
			if (msg.needsSettings) {
				buttons.push(this.button("Open settings", "aichat-open-settings", () => this.plugin.openSettings()));
			}
			if (buttons.length) {
				let row = this.el("div", "aichat-error-actions");
				row.append(...buttons);
				err.append(row);
			}
			wrap.append(err);
		}
		if (msg.notice) {
			wrap.append(this.el("div", "aichat-status", msg.notice));
		}
		if ((msg.status === "done" || msg.status === "stopped") && msg.text) {
			let item = this.item;
			let question = conv.messages[index - 1]?.text || "";
			let imageCount = conv.messages[index - 1]?.images?.length || 0;
			let actions = this.el("div", "aichat-actions");
			let copy = this.iconButton("copy", "Copy", "aichat-copy", () => {
				Zotero.Utilities.Internal.copyTextToClipboard(msg.text);
				this.flash(copy, "Copied");
			});
			let save = this.iconButton("note", "Save as note", "aichat-save-note", async () => {
				await this.saveNote(save, item, [{ question, answer: msg.text, model: msg.model, imageCount }]);
			});
			actions.append(copy, save);
			if (msg.model) actions.append(this.el("span", "aichat-model", msg.model));
			wrap.append(actions);
		}
		return wrap;
	}

	getExchanges() {
		let exchanges = [];
		let messages = this.conv?.messages || [];
		for (let i = 0; i + 1 < messages.length; i += 2) {
			let reply = messages[i + 1];
			if ((reply.status === "done" || reply.status === "stopped") && reply.text.trim()) {
				exchanges.push({ question: messages[i].text, answer: reply.text, model: reply.model, imageCount: messages[i].images?.length || 0 });
			}
		}
		return exchanges;
	}

	async saveChat() {
		let exchanges = this.getExchanges();
		if (exchanges.length) await this.saveNote(this.saveChatButton, this.item, exchanges);
	}

	async saveNote(button, item, exchanges) {
		button.disabled = true;
		try {
			await this.plugin.saveAsNote(item, exchanges);
			this.flash(button, "Saved as a note");
		}
		catch (e) {
			Zotero.logError(e);
			this.setNote("Couldn't save the note: " + (e.message || e), true);
		}
		this.win.setTimeout(() => {
			button.disabled = false;
			if (button === this.saveChatButton) this.updateControls();
		}, 1600);
	}
};
