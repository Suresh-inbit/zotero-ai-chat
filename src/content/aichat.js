/* global Zotero, Services, DOMParser, TextDecoder, setTimeout, clearTimeout */
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
	STYLE_ID: "zotero-ai-chat-style",
	FTL_FILE: "zotero-ai-chat.ftl",

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

	paneID: null,
	prefPaneID: null,
	conversations: new Map(),
	views: new Map(),

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	async startup() {
		// Exposed so the settings pane script (which runs in the preferences window) can reach us
		Zotero.AIChat = this;

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
	},

	shutdown() {
		for (let conv of this.conversations.values()) {
			if (conv.abort) conv.abort.abort();
		}
		for (let view of this.views.values()) {
			view.destroy();
		}
		this.views.clear();
		this.conversations.clear();
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

	ensureStyle(doc) {
		if (doc.getElementById(this.STYLE_ID)) return;
		let link = doc.createElementNS(this.HTML_NS, "link");
		link.id = this.STYLE_ID;
		link.rel = "stylesheet";
		link.type = "text/css";
		link.href = this.rootURI + "content/aichat.css";
		doc.documentElement.appendChild(link);
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

	getSettings() {
		let provider = this.getPref("provider") === "openai" ? "openai" : "anthropic";
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
		return null;
	},

	openSettings() {
		Zotero.Utilities.Internal.openPreferences(this.prefPaneID);
	},

	// ---------------------------------------------------------------------
	// Conversations
	// ---------------------------------------------------------------------

	getConversation(item) {
		let conv = this.conversations.get(item.id);
		if (!conv) {
			conv = {
				itemID: item.id,
				messages: [],
				context: null,
				busy: false,
				abort: null,
				draft: "",
				listeners: new Set(),
				notifyTimer: null,
				turn: null
			};
			this.conversations.set(item.id, conv);
		}
		return conv;
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

	clearConversation(conv) {
		if (conv.abort) conv.abort.abort();
		// Detach any in-flight request so its completion doesn't touch the new chat
		conv.turn = null;
		conv.busy = false;
		conv.abort = null;
		conv.messages = [];
		conv.context = null;
		this.notify(conv);
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
				history.push({ role: "user", content: user.text });
				history.push({ role: "assistant", content: reply.text });
			}
		}
		return history;
	},

	async send(conv, item, win, question) {
		question = question.trim();
		if (!question || conv.busy) return;

		let settings = this.getSettings();
		let history = this.buildHistory(conv);
		let reply = { role: "assistant", text: "", status: "streaming", phase: null, model: settings.model };
		conv.messages.push({ role: "user", text: question, status: "done" }, reply);

		let problem = this.checkSettings(settings);
		if (problem) {
			reply.status = "error";
			reply.error = problem;
			reply.needsSettings = true;
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

			let messages = history.concat({ role: "user", content: question });
			let onText = (delta) => {
				reply.phase = null;
				reply.text += delta;
				this.scheduleNotify(conv);
			};
			let result = settings.provider === "openai"
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
			this.notify(conv);
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
			+ "Keep responses focused and concise unless the user asks for depth. Format answers in Markdown."
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
			messages
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
			messages: [{ role: "system", content: context.system + "\n\n" + context.document }].concat(messages)
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
			let result = settings.provider === "openai"
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
			? exchanges[0].question.replace(/\s+/g, " ").slice(0, 100)
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
			AIChatMarkdown.appendText(htmlDoc, q, ex.question);
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
 * output can never inject markup into Zotero's window.
 */
var AIChatMarkdown = {
	HTML_NS: "http://www.w3.org/1999/xhtml",
	LIST_RE: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,

	el(doc, tag, className) {
		let e = doc.createElementNS(this.HTML_NS, tag);
		if (className) e.className = className;
		return e;
	},

	render(doc, parent, src, options = {}) {
		let lines = String(src).replace(/\r\n?/g, "\n").split("\n");
		let para = [];
		let flushPara = () => {
			if (para.length) {
				let p = this.el(doc, "p");
				this.renderInline(doc, p, para.join("\n"), options);
				parent.append(p);
				para = [];
			}
		};

		let i = 0;
		while (i < lines.length) {
			let line = lines[i];
			let m;

			// Fenced code block
			if ((m = line.match(/^\s*(`{3,}|~{3,})\s*([^`\s]*)\s*$/))) {
				flushPara();
				let fence = m[1];
				let closeRE = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
				let code = [];
				i++;
				while (i < lines.length && !closeRE.test(lines[i])) {
					code.push(lines[i]);
					i++;
				}
				i++;
				let pre = this.el(doc, "pre");
				let codeEl = this.el(doc, "code");
				codeEl.textContent = code.join("\n");
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
				this.render(doc, bq, quoted.join("\n"), options);
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
		let re = /(`+)([\s\S]+?)\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\*\*(?!\s)([^\n]+?)\*\*|__(?!\s)([^\n]+?)__|\*(?![\s*])([^*\n]+?)\*|(?<![\p{L}\p{N}_])_(?![\s_])([^_\n]+?)_(?![\p{L}\p{N}_])|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/gu;
		let last = 0;
		let m;
		while ((m = re.exec(text))) {
			if (m.index > last) this.appendText(doc, parent, text.slice(last, m.index));
			if (m[1] !== undefined) {
				let code = this.el(doc, "code");
				code.textContent = m[2];
				parent.append(code);
			}
			else if (m[3] !== undefined) {
				parent.append(this.makeLink(doc, m[3], m[4], options, true));
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
		if (last < text.length) this.appendText(doc, parent, text.slice(last));
	},

	makeLink(doc, label, url, options, parseLabel) {
		let safe = /^https?:\/\//i.test(url);
		if (!safe) {
			// Not a web link; show the label as plain text
			let span = this.el(doc, "span");
			this.appendText(doc, span, label);
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

	appendText(doc, parent, text) {
		let parts = String(text).split("\n");
		parts.forEach((part, idx) => {
			if (idx > 0) parent.append(this.el(doc, "br"));
			if (part) parent.append(doc.createTextNode(part));
		});
	}
};


/**
 * The chat UI inside one item pane section. One instance per section body; it shows
 * the conversation of whichever item is currently selected.
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
		this.renderedCount = -1;
		this.listener = () => this.update();
		this.build();
	}

	el(tag, className, text) {
		let e = this.doc.createElementNS(this.plugin.HTML_NS, tag);
		if (className) e.className = className;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	button(label, className, onClick, title) {
		let b = this.el("button", "aichat-button " + (className || ""), label);
		b.type = "button";
		if (title) b.title = title;
		b.addEventListener("click", onClick);
		return b;
	}

	build() {
		let root = this.el("div", "aichat-root");

		let toolbar = this.el("div", "aichat-toolbar");
		this.saveChatButton = this.button("Save chat", "", () => this.saveChat(), "Save the whole conversation as a note");
		this.newChatButton = this.button("New chat", "", () => this.newChat(), "Start a new conversation about this item");
		let settingsButton = this.button("Settings", "", () => this.plugin.openSettings(), "Open AI Chat settings");
		toolbar.append(this.saveChatButton, this.newChatButton, settingsButton);

		this.messagesEl = this.el("div", "aichat-messages");
		this.contextLabel = this.el("div", "aichat-context");

		let inputRow = this.el("div", "aichat-input-row");
		this.input = this.el("textarea", "aichat-input");
		this.input.rows = 3;
		this.input.placeholder = "Ask about this item… (Enter to send, Shift+Enter for a new line)";
		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				this.submit();
			}
		});
		this.input.addEventListener("input", () => {
			if (this.conv) this.conv.draft = this.input.value;
		});
		this.sendButton = this.button("Send", "aichat-send", () => {
			if (this.conv?.busy) this.conv.abort?.abort();
			else this.submit();
		});
		inputRow.append(this.input, this.sendButton);

		root.append(toolbar, this.messagesEl, this.contextLabel, inputRow);
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
			// Forget conversations that were only looked at, so browsing doesn't accumulate them
			if (!old.messages.length && !old.draft && !old.busy && !old.listeners.size) {
				this.plugin.conversations.delete(old.itemID);
			}
		}
		this.item = item;
		this.conv = this.plugin.getConversation(item);
		this.conv.listeners.add(this.listener);
		this.input.value = this.conv.draft || "";
		this.renderAll();
	}

	destroy() {
		if (this.conv) this.conv.listeners.delete(this.listener);
		this.conv = null;
		this.item = null;
		this.body.replaceChildren();
	}

	submit() {
		if (!this.conv || this.conv.busy) return;
		let text = this.input.value.trim();
		if (!text) return;
		this.input.value = "";
		this.conv.draft = "";
		this.plugin.send(this.conv, this.item, this.win, text);
	}

	ask(text) {
		if (!this.conv || this.conv.busy) return;
		this.plugin.send(this.conv, this.item, this.win, text);
	}

	newChat() {
		if (this.conv) this.plugin.clearConversation(this.conv);
		this.input.focus();
	}

	isNearBottom() {
		let el = this.messagesEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
	}

	scrollToBottom() {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	update() {
		if (!this.conv) return;
		if (this.conv.messages.length !== this.renderedCount) {
			this.renderAll();
			return;
		}
		// Only the last answer changes while streaming
		let stick = this.isNearBottom();
		let last = this.conv.messages.length - 1;
		let node = this.messagesEl.lastElementChild;
		if (last >= 0 && node) {
			node.replaceWith(this.renderMessage(this.conv.messages[last], last));
		}
		this.updateControls();
		if (stick) this.scrollToBottom();
	}

	renderAll() {
		let conv = this.conv;
		if (!conv) return;
		this.messagesEl.replaceChildren();
		if (!conv.messages.length) {
			this.messagesEl.append(this.renderEmpty());
		}
		else {
			conv.messages.forEach((msg, index) => {
				this.messagesEl.append(this.renderMessage(msg, index));
			});
		}
		this.renderedCount = conv.messages.length;
		this.updateControls();
		this.scrollToBottom();
	}

	updateControls() {
		let conv = this.conv;
		let busy = !!conv?.busy;
		this.sendButton.textContent = busy ? "Stop" : "Send";
		this.sendButton.classList.toggle("aichat-stop", busy);
		this.newChatButton.disabled = !conv?.messages.length;
		this.saveChatButton.disabled = busy || !this.getExchanges().length;
		this.contextLabel.textContent = conv?.context
			? "Context: " + conv.context.summary
			: "The item's full text, metadata and annotations are sent with your question.";
	}

	renderEmpty() {
		let box = this.el("div", "aichat-empty");
		box.append(this.el("div", "aichat-empty-title", "Try asking:"));
		let chips = this.el("div", "aichat-suggestions");
		for (let suggestion of this.plugin.SUGGESTIONS) {
			chips.append(this.button(suggestion, "aichat-chip", () => this.ask(suggestion)));
		}
		box.append(chips);
		return box;
	}

	renderMessage(msg, index) {
		if (msg.role === "user") {
			let wrap = this.el("div", "aichat-msg aichat-user");
			wrap.append(this.el("div", "aichat-bubble", msg.text));
			return wrap;
		}

		let wrap = this.el("div", "aichat-msg aichat-assistant");
		if (msg.text) {
			let content = this.el("div", "aichat-bubble aichat-markdown");
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
			let err = this.el("div", "aichat-error", msg.error || "Something went wrong.");
			if (msg.needsSettings) {
				err.append(" ", this.button("Open settings", "aichat-inline", () => this.plugin.openSettings()));
			}
			wrap.append(err);
		}
		if (msg.notice) {
			wrap.append(this.el("div", "aichat-status", msg.notice));
		}
		if ((msg.status === "done" || msg.status === "stopped") && msg.text) {
			let item = this.item;
			let question = this.conv.messages[index - 1]?.text || "";
			let actions = this.el("div", "aichat-actions");
			let copy = this.button("Copy", "aichat-small", () => {
				Zotero.Utilities.Internal.copyTextToClipboard(msg.text);
				copy.textContent = "Copied";
				setTimeout(() => copy.textContent = "Copy", 1500);
			});
			let save = this.button("Save as note", "aichat-small", async () => {
				await this.saveNote(save, item, [{ question, answer: msg.text, model: msg.model }]);
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
				exchanges.push({ question: messages[i].text, answer: reply.text, model: reply.model });
			}
		}
		return exchanges;
	}

	async saveChat() {
		let exchanges = this.getExchanges();
		if (exchanges.length) await this.saveNote(this.saveChatButton, this.item, exchanges);
	}

	async saveNote(button, item, exchanges) {
		let original = button.textContent;
		button.disabled = true;
		try {
			await this.plugin.saveAsNote(item, exchanges);
			button.textContent = "Saved";
		}
		catch (e) {
			Zotero.logError(e);
			button.textContent = "Save failed";
			button.title = e.message || String(e);
		}
		setTimeout(() => {
			button.textContent = original;
			button.disabled = false;
			if (button === this.saveChatButton) this.updateControls();
		}, 2000);
	}
};
