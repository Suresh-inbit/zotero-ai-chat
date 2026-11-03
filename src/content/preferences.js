/* global Zotero, document */
// Runs in the preferences window, in a scope of its own. Inline handlers in
// preferences.xhtml can't see this scope, so listeners are attached here once the
// pane's markup has loaded.

var ZoteroAIChatPrefs = {
	PROVIDERS: ["anthropic", "openai", "openrouter", "requesty"],

	init(root) {
		this.root = root;
		this.provider = root.querySelector("#zotero-ai-chat-provider");
		this.testButton = root.querySelector("#zotero-ai-chat-test");
		this.testResult = root.querySelector("#zotero-ai-chat-test-result");

		this.provider.addEventListener("command", () => this.updateVisibility());
		// Fired when the menulist value is filled in from the stored preference
		this.provider.addEventListener("syncfrompreference", () => this.updateVisibility());
		this.testButton.addEventListener("command", () => this.test());
		this.clearButton = root.querySelector("#zotero-ai-chat-clear-history");
		this.clearResult = root.querySelector("#zotero-ai-chat-clear-history-result");
		this.clearButton.addEventListener("command", () => this.clearHistory());
		for (let provider of this.PROVIDERS) {
			this.initModelList(provider);
		}
		this.updateVisibility();
	},

	el(id) {
		return this.root.querySelector("#" + id);
	},

	initModelList(provider) {
		this.el(`zotero-ai-chat-${provider}-fetch`).addEventListener("command", () => this.fetchModels(provider));
		this.el(`zotero-ai-chat-${provider}-available`).addEventListener("change", () => this.pickModel(provider));
	},

	updateVisibility() {
		for (let provider of this.PROVIDERS) {
			this.root.querySelector(`#zotero-ai-chat-${provider}`).hidden = this.provider.value !== provider;
		}
	},

	async fetchModels(provider) {
		let button = this.el(`zotero-ai-chat-${provider}-fetch`);
		let select = this.el(`zotero-ai-chat-${provider}-available`);
		if (!Zotero.AIChat) {
			this.setStatus(provider, "AI Chat is not running. Restart Zotero and try again.", false);
			return;
		}
		button.disabled = true;
		this.setStatus(provider, "Loading models…", null);
		try {
			let ids = await Zotero.AIChat.listModels(provider);
			select.replaceChildren();
			let placeholder = this.createOption("", "Choose a model…");
			select.append(placeholder);
			for (let id of ids) {
				select.append(this.createOption(id, id));
			}
			select.value = "";
			select.hidden = false;
			this.setStatus(provider, `Found ${ids.length} model${ids.length == 1 ? "" : "s"}. Pick one to use it.`, true);
		}
		catch (e) {
			this.setStatus(provider, e.message || String(e), false);
		}
		finally {
			button.disabled = false;
		}
	},

	// Picking a fetched model sets it as the model and adds it to the favorites
	pickModel(provider) {
		let select = this.el(`zotero-ai-chat-${provider}-available`);
		let model = select.value;
		if (!model) return;

		let modelField = this.el(`zotero-ai-chat-${provider}-model`);
		modelField.value = model;
		modelField.dispatchEvent(new Event("input"));

		let favorites = this.el(`zotero-ai-chat-${provider}-favorites`);
		let list = favorites.value.split("\n").map((m) => m.trim()).filter(Boolean);
		if (!list.includes(model)) {
			list.push(model);
			favorites.value = list.join("\n");
			favorites.dispatchEvent(new Event("input"));
		}
		select.value = "";
		this.setStatus(provider, `Model set to ${model}.`, true);
	},

	createOption(value, label) {
		let option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
		option.value = value;
		option.textContent = label;
		return option;
	},

	setStatus(provider, text, ok) {
		let el = this.el(`zotero-ai-chat-${provider}-fetch-status`);
		el.textContent = text;
		el.style.color = ok === false ? "var(--accent-red, #d70022)" : "";
	},

	async test() {
		if (!Zotero.AIChat) {
			this.showResult("AI Chat is not running. Restart Zotero and try again.", false);
			return;
		}
		this.testButton.disabled = true;
		this.showResult("Testing…", null);
		try {
			this.showResult(await Zotero.AIChat.testConnection(), true);
		}
		catch (e) {
			this.showResult(e.message || String(e), false);
		}
		finally {
			this.testButton.disabled = false;
		}
	},

	// The first click asks for confirmation; a second click within a few seconds deletes
	async clearHistory() {
		let win = document.defaultView;
		if (!Zotero.AIChat) {
			this.showClearResult("AI Chat is not running. Restart Zotero and try again.", false);
			return;
		}
		if (!this.clearArmed) {
			this.clearArmed = true;
			this.clearButton.setAttribute("label", "Click again to delete every saved chat");
			this.showClearResult("This can't be undone.", null);
			this.clearTimer = win.setTimeout(() => this.disarmClear(true), 5000);
			return;
		}
		this.disarmClear(false);
		this.clearButton.disabled = true;
		try {
			await Zotero.AIChat.clearAllHistory();
			this.showClearResult("All chat history was deleted.", true);
		}
		catch (e) {
			this.showClearResult(e.message || String(e), false);
		}
		finally {
			this.clearButton.disabled = false;
		}
	},

	disarmClear(clearMessage) {
		document.defaultView.clearTimeout(this.clearTimer);
		this.clearArmed = false;
		this.clearButton.setAttribute("label", "Delete all chat history");
		if (clearMessage) this.showClearResult("", null);
	},

	showClearResult(text, ok) {
		this.clearResult.textContent = text;
		this.clearResult.style.color = ok === false ? "var(--accent-red, #d70022)" : "";
	},

	showResult(text, ok) {
		this.testResult.textContent = text;
		this.testResult.style.color = ok === false ? "var(--accent-red, #d70022)" : "";
	}
};

// Zotero dispatches a "load" event on the pane's root element after inserting it.
// Listen on the document: element load events never propagate to the window.
function onAIChatPaneLoad(event) {
	if (event.target?.id !== "zotero-ai-chat-prefs") return;
	document.removeEventListener("load", onAIChatPaneLoad, true);
	ZoteroAIChatPrefs.init(event.target);
}

let existingRoot = document.getElementById("zotero-ai-chat-prefs");
if (existingRoot) {
	ZoteroAIChatPrefs.init(existingRoot);
}
else {
	document.addEventListener("load", onAIChatPaneLoad, true);
}
