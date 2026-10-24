/* global Zotero, Services, IOUtils, PathUtils, ChromeUtils, setTimeout */
// Integration test harness. Installed only into a throwaway profile by
// tests/run_integration.sh. Never install this into a real profile: it creates test
// items and quits Zotero when done.

var results = [];
var config = {};

function log(msg) {
	Zotero.debug("UI-HARNESS: " + msg);
}

function check(name, condition, detail) {
	let entry = { name, ok: !!condition, detail: detail === undefined ? "" : String(detail).slice(0, 3000) };
	results.push(entry);
	log(`${entry.ok ? "PASS" : "FAIL"} ${name}${entry.detail ? " :: " + entry.detail : ""}`);
	return entry.ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 15000, label = "condition") {
	let start = Date.now();
	let lastError;
	while (Date.now() - start < timeout) {
		try {
			let value = await fn();
			if (value) return value;
		}
		catch (e) {
			lastError = e;
		}
		await sleep(100);
	}
	throw new Error(`Timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ""}`);
}

async function step(name, fn) {
	log("STEP " + name);
	try {
		await fn();
	}
	catch (e) {
		check(`${name} (step failed)`, false, (e && (e.stack ? e.message + "\n" + e.stack : e.message)) || e);
	}
}

function setPrefs(values) {
	for (let [key, value] of Object.entries(values)) {
		Zotero.Prefs.set("extensions.zotero-ai-chat." + key, value, true);
	}
}

async function readRequests() {
	try {
		let text = await IOUtils.readUTF8(config.logPath);
		return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	}
	catch (e) {
		return [];
	}
}

async function screenshot(win, name) {
	try {
		let bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
		let canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext("2d").drawImage(bitmap, 0, 0);
		let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
		let bytes = new Uint8Array(await blob.arrayBuffer());
		await IOUtils.write(PathUtils.join(config.outDir, name + ".png"), bytes);
		log("screenshot saved: " + name);
	}
	catch (e) {
		log("screenshot failed: " + e);
	}
}

// The chat must fit inside the item pane: nothing may stick out past its right edge
function checkLayout(win, details, root, label) {
	let pane = details.getBoundingClientRect();
	let chat = root.getBoundingClientRect();
	let widest = 0;
	for (let el of root.querySelectorAll(".aichat-toolbar, .aichat-messages, .aichat-input-row, .aichat-context")) {
		widest = Math.max(widest, el.getBoundingClientRect().right);
	}
	check(`layout fits (${label})`, chat.width > 150 && chat.right <= pane.right + 1 && widest <= pane.right + 1,
		`pane ${Math.round(pane.left)}-${Math.round(pane.right)}, chat ${Math.round(chat.left)}-${Math.round(chat.right)}, widest child right ${Math.round(widest)}`);
	let buttons = [...root.querySelectorAll(".aichat-toolbar button")];
	check(`toolbar buttons visible (${label})`, buttons.length === 3 && buttons.every((b) => b.getBoundingClientRect().right <= pane.right + 1));
}

function findSection(container, paneID) {
	return [...container.querySelectorAll("item-pane-custom-section")].find((e) => e.dataset.pane === paneID);
}

async function openChat(win, details, paneID) {
	let section = await waitFor(() => findSection(details, paneID), 15000, "chat section element");
	await details.scrollToPane(paneID, "instant");
	let root = await waitFor(() => section.querySelector(".aichat-root"), 15000, "chat UI");
	return { section, root };
}

async function ask(root, conv, text, expectedCount, { useEnter = false } = {}) {
	let win = root.ownerGlobal;
	let input = root.querySelector(".aichat-input");
	input.value = text;
	input.dispatchEvent(new win.Event("input", { bubbles: true }));
	if (useEnter) {
		input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	}
	else {
		root.querySelector(".aichat-send").click();
	}
	await waitFor(() => conv.messages.length === expectedCount && !conv.busy, 30000, `reply to "${text}"`);
	// Let the throttled UI refresh run
	await sleep(250);
	return conv.messages[expectedCount - 1];
}

async function run() {
	config = {
		outDir: Zotero.Prefs.get("extensions.uiharness.outDir", true),
		port: Zotero.Prefs.get("extensions.uiharness.port", true),
		pdfPath: Zotero.Prefs.get("extensions.uiharness.pdfPath", true),
		logPath: Zotero.Prefs.get("extensions.uiharness.logPath", true)
	};
	log("config " + JSON.stringify(config));

	await Zotero.uiReadyPromise;
	let win = await waitFor(() => {
		let w = Zotero.getMainWindow();
		return w && w.ZoteroPane && w.ZoteroPane.itemsView ? w : null;
	}, 60000, "main window");
	win.resizeTo(1500, 950);
	if (win.ZoteroPane.itemsView.waitForLoad) await win.ZoteroPane.itemsView.waitForLoad();
	await sleep(500);

	let AIChat;
	let item, att, item2;
	let details = win.document.getElementById("zotero-item-details");

	await step("plugin startup", async () => {
		AIChat = await waitFor(() => Zotero.AIChat, 30000, "Zotero.AIChat");
		check("plugin loaded (Zotero.AIChat present)", !!AIChat, AIChat.version);
		check("item pane section registered", !!AIChat.paneID, AIChat.paneID);
		check("settings pane registered", !!AIChat.prefPaneID, AIChat.prefPaneID);
		check("Fluent file linked in main window", !!win.document.querySelector('link[href="zotero-ai-chat.ftl"]'));
		check("stylesheet linked in main window", !!win.document.getElementById("zotero-ai-chat-style"));
		check("default model pref", Zotero.Prefs.get("extensions.zotero-ai-chat.anthropic.model", true) === "claude-opus-5-5");
	});
	if (!AIChat) return;

	setPrefs({
		provider: "anthropic",
		"anthropic.apiKey": "test-key",
		"anthropic.baseURL": `http://127.0.0.1:${config.port}`,
		"anthropic.model": "claude-opus-5-5",
		"anthropic.effort": "medium"
	});

	await step("create test items", async () => {
		item = new Zotero.Item("journalArticle");
		item.setField("title", "Attention Test Paper");
		item.setCreators([{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }]);
		item.setField("date", "2017");
		item.setField("abstractNote", "An abstract about self-attention.");
		await item.saveTx();
		att = await Zotero.Attachments.importFromFile({ file: config.pdfPath, parentItemID: item.id });
		check("test PDF imported", att && att.isPDFAttachment(), att && att.attachmentFilename);
		await Zotero.Annotations.saveFromJSON(att, {
			key: Zotero.DataObjectUtilities.generateKey(),
			type: "highlight",
			text: "every token against every other token",
			comment: "MY-ANNOTATION-COMMENT",
			color: "#ffd400",
			pageLabel: "1",
			sortIndex: "00000|000100|00072",
			position: { pageIndex: 0, rects: [[72, 600, 300, 612]] }
		});
		check("annotation created", att.getAnnotations().length === 1);

		item2 = new Zotero.Item("book");
		item2.setField("title", "Metadata Only Book");
		await item2.saveTx();
	});
	if (!item || !att) return;

	let root, section, conv;

	await step("section renders in library item pane", async () => {
		await win.ZoteroPane.selectItem(item.id);
		({ section, root } = await openChat(win, details, AIChat.paneID));
		check("chat UI rendered in item pane", !!root);
		let header = section.querySelector("collapsible-section");
		await waitFor(() => header.getAttribute("label") === "AI Chat", 5000, "localized header").catch(() => {});
		check("section header is localized", header.getAttribute("label") === "AI Chat", header.getAttribute("label"));
		let sidenavButton = [...win.document.querySelectorAll("#zotero-view-item-sidenav .btn[custom]")]
			.find((b) => b.dataset.l10nId === "zotero-ai-chat-sidenav");
		check("sidenav button present", !!sidenavButton);
		await waitFor(() => sidenavButton.getAttribute("tooltiptext") === "AI Chat", 5000, "sidenav tooltip").catch(() => {});
		check("sidenav tooltip is localized", sidenavButton?.getAttribute("tooltiptext") === "AI Chat", sidenavButton?.getAttribute("tooltiptext"));
		check("suggestion chips shown", root.querySelectorAll(".aichat-chip").length === 4);
		checkLayout(win, details, root, "empty chat");
		conv = AIChat.getConversation(item);
		await screenshot(win, "01-library-empty");
	});
	if (!root) return;

	await step("ask a question (Claude format)", async () => {
		let reply = await ask(root, conv, "What is the marker?", 2, { useEnter: true });
		check("reply completed", reply.status === "done", reply.status + " " + (reply.error || ""));
		check("model saw the PDF text", reply.text.includes("CONTEXT-SEEN"), reply.text.slice(0, 120));
		let md = root.querySelectorAll(".aichat-assistant .aichat-markdown")[0];
		check("markdown: heading", !!md?.querySelector("h4"));
		check("markdown: bold/italic", !!md?.querySelector("strong") && !!md?.querySelector("em"));
		check("markdown: table", md?.querySelectorAll("table td").length === 4, md?.querySelectorAll("table td").length);
		check("markdown: code block", md?.querySelector("pre code")?.textContent === 'print("hello <world>")', md?.querySelector("pre code")?.textContent);
		check("markdown: nested list", !!md?.querySelector("ul ul li"));
		let link = md?.querySelector("a.aichat-link");
		check("markdown: link rendered without href", link && !link.hasAttribute("href") && link.title === "https://example.org/paper", link?.outerHTML);
		let linkColor = win.getComputedStyle(link).color;
		let bubbleColor = win.getComputedStyle(md).backgroundColor;
		check("link text is visible (not the background color)", linkColor !== bubbleColor && linkColor !== "rgb(255, 255, 255)", `${linkColor} on ${bubbleColor}`);
		checkLayout(win, details, root, "library pane after a long answer");
		check("thinking text is not shown", !root.textContent.includes("SECRET-THOUGHTS"));
		let contextText = root.querySelector(".aichat-context").textContent;
		check("context label names the PDF and annotation", contextText.includes(".pdf") && contextText.includes("1 annotation"), contextText);
		check("input cleared after sending", root.querySelector(".aichat-input").value === "");

		let requests = (await readRequests()).filter((r) => r.path === "/v1/messages");
		let r = requests[requests.length - 1];
		check("request headers", r.headers["x-api-key"] === "test-key" && r.headers["anthropic-version"] === "2026-10-21"
			&& r.headers["content-type"] === "application/json", JSON.stringify(r.headers));
		check("no fallback sent to a non-Claude-API URL", !r.headers["anthropic-beta"] && r.body.fallbacks === undefined);
		check("request body basics", r.body.model === "claude-opus-5-5" && r.body.max_tokens === 64000 && r.body.stream === true
			&& r.body.output_config?.effort === "medium" && r.body.temperature === undefined, JSON.stringify(r.body.output_config));
		let doc = r.body.system[1].text;
		check("context: PDF full text", doc.includes("QUANTUM-BANANA-42"));
		check("context: metadata", doc.includes("Attention Test Paper") && doc.includes("Ada Lovelace")
			&& doc.includes("An abstract about self-attention.") && doc.includes("Date: 2017"), doc.slice(0, 600));
		check("context: annotation", doc.includes("MY-ANNOTATION-COMMENT") && doc.includes("every token against every other token"));
		check("context: cache breakpoint", r.body.system[1].cache_control?.type === "ephemeral");
		check("messages: single user turn", r.body.messages.length === 1 && r.body.messages[0].content === "What is the marker?");
	});

	await step("follow-up keeps history and an identical system prompt", async () => {
		let reply = await ask(root, conv, "Follow-up question", 4);
		check("follow-up reply completed", reply.status === "done", reply.error);
		let requests = (await readRequests()).filter((r) => r.path === "/v1/messages");
		let first = requests[requests.length - 2];
		let last = requests[requests.length - 1];
		check("follow-up sends 3 messages", last.body.messages.length === 3
			&& last.body.messages[0].content === "What is the marker?"
			&& last.body.messages[1].role === "assistant" && last.body.messages[1].content.includes("CONTEXT-SEEN")
			&& last.body.messages[2].content === "Follow-up question", JSON.stringify(last.body.messages).slice(0, 300));
		check("system prompt identical across turns (cacheable)", JSON.stringify(first.body.system) === JSON.stringify(last.body.system));
		check("two answers rendered", root.querySelectorAll(".aichat-assistant").length === 2);
	});

	await step("copy and save as note", async () => {
		let assistants = root.querySelectorAll(".aichat-assistant");
		let lastActions = assistants[assistants.length - 1].querySelectorAll(".aichat-actions button");
		let copyBtn = [...lastActions].find((b) => b.textContent === "Copy");
		copyBtn.click();
		check("copy button confirms", copyBtn.textContent === "Copied");

		let saveBtn = [...lastActions].find((b) => b.textContent === "Save as note");
		let before = item.getNotes().length;
		saveBtn.click();
		await waitFor(() => item.getNotes().length === before + 1, 10000, "note saved");
		let html = Zotero.Items.get(item.getNotes()).map((n) => n.getNote())
			.find((h) => h.includes("<h1>AI: Follow-up question</h1>")) || "";
		check("child note created with the answer", html.includes("Follow-up question") && html.includes("CONTEXT-SEEN")
			&& html.includes("<table>") && html.includes('href="https://example.org/paper"') && html.includes("<h1>AI: Follow-up question</h1>"), html.slice(0, 500));
		check("note footer names the model", html.includes("claude-opus-5-5"));

		let saveChat = [...root.querySelectorAll(".aichat-toolbar button")].find((b) => b.textContent === "Save chat");
		saveChat.click();
		await waitFor(() => item.getNotes().length === before + 2, 10000, "chat note saved");
		// getNotes() isn't ordered by creation, so find the note by its title
		let chatNote = Zotero.Items.get(item.getNotes()).map((n) => n.getNote())
			.find((h) => h.includes("<h1>AI: Chat about Attention Test Paper</h1>")) || "";
		check("whole-chat note has both questions", chatNote.includes("What is the marker?") && chatNote.includes("Follow-up question") && chatNote.includes("<hr>"), chatNote.slice(0, 300));
	});

	await step("API error is shown", async () => {
		let reply = await ask(root, conv, "please FAIL401", 6);
		check("401 becomes an error message", reply.status === "error" && /API error 401/.test(reply.error), reply.error);
		let errorEls = root.querySelectorAll(".aichat-error");
		check("error rendered with hint", errorEls.length && errorEls[errorEls.length - 1].textContent.includes("Check your API key"));
	});

	await step("Stop button aborts a streaming answer", async () => {
		let input = root.querySelector(".aichat-input");
		let send = root.querySelector(".aichat-send");
		input.value = "SLOW please";
		send.click();
		await waitFor(() => conv.messages[7]?.text.includes("slow chunk 1"), 15000, "slow stream to start");
		check("button shows Stop while streaming", send.textContent === "Stop");
		await screenshot(win, "02-library-streaming");
		send.click();
		await waitFor(() => !conv.busy, 10000, "stop");
		await sleep(200);
		check("answer marked stopped", conv.messages[7].status === "stopped");
		check("UI shows Stopped", root.textContent.includes("Stopped."));
		check("button back to Send", send.textContent === "Send");
		let requests = (await readRequests()).filter((r) => r.path === "/v1/messages");
		let last = requests[requests.length - 1];
		check("history excludes the failed turn", !JSON.stringify(last.body.messages).includes("FAIL401"));
	});

	await step("conversations are per item", async () => {
		await win.ZoteroPane.selectItem(item2.id);
		await details.scrollToPane(AIChat.paneID, "instant");
		await waitFor(() => root.querySelector(".aichat-empty"), 10000, "empty chat for second item");
		let conv2 = AIChat.getConversation(item2);
		let reply = await ask(root, conv2, "Anything?", 2);
		check("metadata-only item answers without full text", reply.text.includes("CONTEXT-MISSING"), reply.text.slice(0, 80));
		check("context label says no full text", root.querySelector(".aichat-context").textContent.includes("No full text found"));
		await win.ZoteroPane.selectItem(item.id);
		await details.scrollToPane(AIChat.paneID, "instant");
		await waitFor(() => root.querySelectorAll(".aichat-msg").length === conv.messages.length, 10000, "first chat restored");
		check("first item's chat restored", root.querySelectorAll(".aichat-msg").length === 8);
		await screenshot(win, "03-library-chat");
	});

	await step("OpenAI-compatible provider", async () => {
		setPrefs({
			provider: "openai",
			"openai.baseURL": `http://127.0.0.1:${config.port}/v1`,
			"openai.model": "test-model",
			"openai.apiKey": ""
		});
		[...root.querySelectorAll(".aichat-toolbar button")].find((b) => b.textContent === "New chat").click();
		await waitFor(() => root.querySelector(".aichat-chip"), 5000, "empty state after New chat");
		check("New chat clears the conversation", conv.messages.length === 0 && conv.context === null);
		root.querySelector(".aichat-chip").click();
		await waitFor(() => conv.messages.length === 2 && !conv.busy, 20000, "openai reply");
		await sleep(250);
		let reply = conv.messages[1];
		check("suggestion chip sends its question", conv.messages[0].text === "Summarize this paper");
		check("OpenAI-format reply", reply.status === "done" && reply.text.includes("CONTEXT-SEEN"), reply.error || reply.text.slice(0, 80));
		let r = (await readRequests()).filter((x) => x.path === "/v1/chat/completions").pop();
		check("OpenAI request shape", r && r.body.model === "test-model" && r.body.stream === true
			&& r.body.messages[0].role === "system" && r.body.messages[0].content.includes("QUANTUM-BANANA-42")
			&& !r.headers.authorization, r && JSON.stringify(r.headers));
	});

	await step("missing API key shows a settings prompt", async () => {
		setPrefs({ provider: "anthropic", "anthropic.apiKey": "" });
		let reply = await ask(root, conv, "No key?", 4);
		check("missing key error", reply.status === "error" && reply.error.includes("No Claude API key"), reply.error);
		let errors = root.querySelectorAll(".aichat-error");
		check("Open settings button offered", !!errors[errors.length - 1].querySelector("button"));
		setPrefs({ "anthropic.apiKey": "test-key" });
	});

	await step("reader tab", async () => {
		let reader = await Zotero.Reader.open(att.id);
		await waitFor(() => win.Zotero_Tabs.selectedType === "reader", 20000, "reader tab");
		if (win.ZoteroContextPane.collapsed) win.ZoteroContextPane.togglePane();
		let ctxDetails = await waitFor(() => win.document.getElementById(reader.tabID + "-context"), 20000, "reader item pane");
		let { root: readerRoot } = await openChat(win, ctxDetails, AIChat.paneID);
		check("chat UI rendered in reader side pane", !!readerRoot);
		await waitFor(() => readerRoot.querySelectorAll(".aichat-msg").length === conv.messages.length, 10000, "shared chat");
		check("reader shows the same conversation as the library", readerRoot.querySelectorAll(".aichat-msg").length === conv.messages.length);
		[...readerRoot.querySelectorAll(".aichat-toolbar button")].find((b) => b.textContent === "New chat").click();
		let reply = await ask(readerRoot, conv, "Question from the reader", 2);
		check("reply in reader", reply.status === "done" && reply.text.includes("CONTEXT-SEEN"), reply.error);
		let r = (await readRequests()).filter((x) => x.path === "/v1/messages").pop();
		check("reader context uses the open PDF", r.body.system[1].text.includes("QUANTUM-BANANA-42")
			&& r.body.system[1].text.includes("Attachment: "), r.body.system[1].text.slice(0, 400));
		checkLayout(win, ctxDetails, readerRoot, "reader side pane");
		await sleep(1500);
		await screenshot(win, "04-reader");
		win.Zotero_Tabs.select("zotero-pane");
		await sleep(300);
	});

	await step("settings pane", async () => {
		Zotero.Utilities.Internal.openPreferences(AIChat.prefPaneID);
		let prefWin = await waitFor(() => Services.wm.getMostRecentWindow("zotero:pref"), 20000, "preferences window");
		let doc = prefWin.document;
		await waitFor(() => doc.getElementById("zotero-ai-chat-prefs"), 20000, "AI Chat pane");
		await waitFor(() => doc.getElementById("zotero-ai-chat-anthropic-key").value === "test-key", 10000, "pref values filled in");
		let provider = doc.getElementById("zotero-ai-chat-provider");
		await waitFor(() => provider.value === "anthropic", 5000, "provider value");
		check("provider menulist reflects pref", provider.value === "anthropic");
		check("Claude section visible, OpenAI hidden",
			!doc.getElementById("zotero-ai-chat-anthropic").hidden && doc.getElementById("zotero-ai-chat-openai").hidden);
		check("model field filled", doc.getElementById("zotero-ai-chat-anthropic-model").value === "claude-opus-5-5");
		check("max chars field filled", doc.getElementById("zotero-ai-chat-max-chars").value === "200000");
		check("annotations checkbox filled", doc.getElementById("zotero-ai-chat-annotations").checked === true);

		provider.value = "openai";
		provider.dispatchEvent(new prefWin.Event("command"));
		await sleep(100);
		check("switching provider saves pref", Zotero.Prefs.get("extensions.zotero-ai-chat.provider", true) === "openai");
		check("switching provider toggles sections",
			doc.getElementById("zotero-ai-chat-anthropic").hidden && !doc.getElementById("zotero-ai-chat-openai").hidden);
		await screenshot(prefWin, "05-settings-openai");
		provider.value = "anthropic";
		provider.dispatchEvent(new prefWin.Event("command"));

		let model = doc.getElementById("zotero-ai-chat-anthropic-model");
		model.value = "claude-sonnet-5-5";
		model.dispatchEvent(new prefWin.Event("input"));
		check("editing model saves pref", Zotero.Prefs.get("extensions.zotero-ai-chat.anthropic.model", true) === "claude-sonnet-5-5");
		model.value = "claude-opus-5-5";
		model.dispatchEvent(new prefWin.Event("input"));

		let maxChars = doc.getElementById("zotero-ai-chat-max-chars");
		maxChars.value = "150000";
		maxChars.dispatchEvent(new prefWin.Event("input"));
		check("editing max chars saves a string pref", Zotero.Prefs.get("extensions.zotero-ai-chat.maxContextChars", true) === "150000");
		check("plugin reads the new limit", AIChat.getMaxContextChars() === 150000);
		maxChars.value = "200000";
		maxChars.dispatchEvent(new prefWin.Event("input"));

		doc.getElementById("zotero-ai-chat-test").dispatchEvent(new prefWin.Event("command"));
		let result = doc.getElementById("zotero-ai-chat-test-result");
		await waitFor(() => result.textContent.startsWith("Connected"), 20000, "test connection result").catch(() => {});
		check("Test connection succeeds", result.textContent.startsWith("Connected") && result.textContent.includes("OK"), result.textContent);
		await screenshot(prefWin, "06-settings-claude");
		prefWin.close();
	});

	await step("disable and re-enable the plugin", async () => {
		const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
		let addon = await AddonManager.getAddonByID("zotero-ai-chat@suresh-inbit");
		await addon.disable();
		await waitFor(() => !Zotero.AIChat, 10000, "plugin shut down");
		await waitFor(() => !findSection(details, AIChat.paneID), 10000, "section removed").catch(() => {});
		check("section removed when disabled", !findSection(details, AIChat.paneID));
		check("stylesheet removed when disabled", !win.document.getElementById("zotero-ai-chat-style"));
		await addon.enable();
		let again = await waitFor(() => Zotero.AIChat, 15000, "plugin restarted");
		check("plugin restarts after re-enable", !!again && again !== AIChat);
		await win.ZoteroPane.selectItem(item2.id);
		await win.ZoteroPane.selectItem(item.id);
		let { root: newRoot } = await openChat(win, details, again.paneID);
		check("chat UI renders after re-enable", !!newRoot);
		let conv3 = again.getConversation(item);
		let reply = await ask(newRoot, conv3, "After re-enable", 2);
		check("chat works after re-enable", reply.status === "done", reply.error);
	});
}

async function finish() {
	let errors = [];
	try {
		errors = Zotero.getErrors(false).map((e) => ({ message: String(e.message || e), source: e.sourceName || "" }));
	}
	catch (e) {}
	let pluginErrors = errors.filter((e) => /zotero-ai-chat|Hobby\/zotero\/src|aichat|AI Chat/i.test(e.message + " " + e.source));
	check("no plugin errors in Zotero's error console", pluginErrors.length === 0,
		pluginErrors.map((e) => `${e.message} @ ${e.source}`).join("\n---\n"));
	try {
		await IOUtils.writeUTF8(PathUtils.join(config.outDir, "results.json"), JSON.stringify({ results, errors }, null, 2));
	}
	catch (e) {
		log("could not write results: " + e);
	}
	log("DONE");
	Services.startup.quit(Services.startup.eForceQuit);
}

function install() {}

function startup() {
	// Don't block Zotero's startup; run once the UI is ready
	run().catch((e) => check("harness crashed", false, e && e.stack || e)).finally(finish);
}

function shutdown() {}

function uninstall() {}
