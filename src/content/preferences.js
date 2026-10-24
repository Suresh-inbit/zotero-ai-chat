/* global Zotero, document */
// Runs in the preferences window, in a scope of its own. Inline handlers in
// preferences.xhtml can't see this scope, so listeners are attached here once the
// pane's markup has loaded.

var ZoteroAIChatPrefs = {
	init(root) {
		this.root = root;
		this.provider = root.querySelector("#zotero-ai-chat-provider");
		this.testButton = root.querySelector("#zotero-ai-chat-test");
		this.testResult = root.querySelector("#zotero-ai-chat-test-result");

		this.provider.addEventListener("command", () => this.updateVisibility());
		// Fired when the menulist value is filled in from the stored preference
		this.provider.addEventListener("syncfrompreference", () => this.updateVisibility());
		this.testButton.addEventListener("command", () => this.test());
		this.updateVisibility();
	},

	updateVisibility() {
		let isOpenAI = this.provider.value === "openai";
		this.root.querySelector("#zotero-ai-chat-anthropic").hidden = isOpenAI;
		this.root.querySelector("#zotero-ai-chat-openai").hidden = !isOpenAI;
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
