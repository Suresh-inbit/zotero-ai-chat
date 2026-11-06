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
	for (let el of root.querySelectorAll(".aichat-header, .aichat-messages, .aichat-composer, .aichat-context")) {
		widest = Math.max(widest, el.getBoundingClientRect().right);
	}
	check(`layout fits (${label})`, chat.width > 150 && chat.right <= pane.right + 1 && widest <= pane.right + 1,
		`pane ${Math.round(pane.left)}-${Math.round(pane.right)}, chat ${Math.round(chat.left)}-${Math.round(chat.right)}, widest child right ${Math.round(widest)}`);
	let buttons = [...root.querySelectorAll(".aichat-header button, .aichat-composer-bar > *")];
	check(`header and composer controls visible (${label})`, buttons.length === 7
		&& buttons.every((b) => b.getBoundingClientRect().right <= pane.right + 1 && b.getBoundingClientRect().width > 0),
		buttons.map((b) => `${b.className.split(" ").pop()}:${Math.round(b.getBoundingClientRect().right)}`).join(" "));
}

// With the chat scrolled into view, it covers the item pane down to its bottom edge: the
// section's title at the top, the text box at the bottom, the messages scrolling between
async function checkFillsPane(details, paneID, root, label) {
	await details.scrollToPane(paneID, "instant");
	await sleep(400);
	let scroller = root.closest(".zotero-view-item");
	let pane = scroller.getBoundingClientRect();
	let section = root.closest("collapsible-section").getBoundingClientRect();
	let chat = root.getBoundingClientRect();
	let composer = root.querySelector(".aichat-composer").getBoundingClientRect();
	let gap = pane.bottom - chat.bottom;
	check(`chat fills the pane to the bottom (${label})`, root.classList.contains("aichat-fit")
		&& Math.abs(section.top - pane.top) <= 2 && gap >= 0 && gap <= 16 && composer.bottom <= pane.bottom,
	`pane ${Math.round(pane.top)}-${Math.round(pane.bottom)}, section top ${Math.round(section.top)}, `
		+ `chat ${Math.round(chat.top)}-${Math.round(chat.bottom)}, composer bottom ${Math.round(composer.bottom)}`);
	return { pane, chat };
}

async function makePNGFile(win, width, height, color, name) {
	let canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = width;
	canvas.height = height;
	let ctx = canvas.getContext("2d");
	let gradient = ctx.createLinearGradient(0, 0, width, height);
	gradient.addColorStop(0, color);
	gradient.addColorStop(1, "#000000");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
	let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	return new win.File([blob], name, { type: "image/png" });
}

// Gecko ignores clipboardData on synthetic ClipboardEvents, so call the view's paste handler
// with an event-shaped object instead. A real clipboard paste is tried separately below.
function pasteInto(plugin, input, { files = [] } = {}) {
	let view = [...plugin.views.values()].find((v) => v.input === input);
	let event = {
		clipboardData: { files },
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		}
	};
	view.onPaste(event);
	return event;
}

// Put a PNG on the system clipboard the way Zotero's own "Copy Image" does
async function putImageOnClipboard(file) {
	const { classes: Cc, interfaces: Ci } = Components;
	let bytes = new Uint8Array(await file.arrayBuffer());
	let container = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools).decodeImageFromArrayBuffer(bytes.buffer, "image/png");
	let trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
	trans.init(null);
	trans.addDataFlavor("application/x-moz-nativeimage");
	trans.setTransferData("application/x-moz-nativeimage", container);
	Services.clipboard.setData(trans, null, Ci.nsIClipboard.kGlobalClipboard);
}

function readClipboardText() {
	const { classes: Cc, interfaces: Ci } = Components;
	let trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
	trans.init(null);
	trans.addDataFlavor("text/plain");
	Services.clipboard.getData(trans, Ci.nsIClipboard.kGlobalClipboard);
	let data = {};
	try {
		trans.getTransferData("text/plain", data);
		return data.value.QueryInterface(Ci.nsISupportsString).data;
	}
	catch (e) {
		return "";
	}
}

function pointer(win, target, type, x, y) {
	target.dispatchEvent(new win.PointerEvent(type, {
		clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true
	}));
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
		await checkFillsPane(details, AIChat.paneID, root, "library, empty chat");
		let empty = root.querySelector(".aichat-empty").getBoundingClientRect();
		let messages = root.querySelector(".aichat-messages").getBoundingClientRect();
		check("suggestions sit in the middle of the empty chat",
			Math.abs((empty.top + empty.bottom) / 2 - (messages.top + messages.bottom) / 2) <= 4,
			`suggestions ${Math.round(empty.top)}-${Math.round(empty.bottom)} in ${Math.round(messages.top)}-${Math.round(messages.bottom)}`);
		check("no paste-image button (Ctrl+V pastes)", !root.querySelector(".aichat-paste"));
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
		let { chat: before } = await checkFillsPane(details, AIChat.paneID, root, "library, long answer");
		check("scrolling past the chat's end doesn't scroll the pane",
			win.getComputedStyle(root.querySelector(".aichat-messages")).overscrollBehaviorY === "contain");
		win.resizeTo(1500, 750);
		await waitFor(() => win.innerHeight < 800, 5000, "smaller window").catch(() => {});
		let { chat: smaller } = await checkFillsPane(details, AIChat.paneID, root, "library, smaller window");
		check("the chat follows the window's height", before.height - smaller.height >= 150,
			`${Math.round(before.height)} -> ${Math.round(smaller.height)}`);
		win.resizeTo(1500, 950);
		await waitFor(() => win.innerHeight > 850, 5000, "window restored").catch(() => {});
		await checkFillsPane(details, AIChat.paneID, root, "library, window restored");
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
		await checkFillsPane(details, AIChat.paneID, root, "library, two answers");
		let messagesEl = root.querySelector(".aichat-messages");
		check("long answers scroll inside the chat, showing the latest", messagesEl.scrollHeight > messagesEl.clientHeight + 20
			&& Math.abs(messagesEl.scrollTop + messagesEl.clientHeight - messagesEl.scrollHeight) <= 2,
		`${messagesEl.scrollHeight} in ${messagesEl.clientHeight}, scrolled to ${messagesEl.scrollTop}`);
		await screenshot(win, "03b-library-two-answers");
	});

	await step("copy and save as note", async () => {
		let assistants = root.querySelectorAll(".aichat-assistant");
		let lastActions = assistants[assistants.length - 1].querySelectorAll(".aichat-actions button");
		let copyBtn = [...lastActions].find((b) => b.classList.contains("aichat-copy"));
		copyBtn.click();
		check("copy button confirms", copyBtn.title === "Copied" && copyBtn.dataset.icon === "check", copyBtn.title);

		let saveBtn = [...lastActions].find((b) => b.classList.contains("aichat-save-note"));
		let before = item.getNotes().length;
		saveBtn.click();
		await waitFor(() => item.getNotes().length === before + 1, 10000, "note saved");
		let html = Zotero.Items.get(item.getNotes()).map((n) => n.getNote())
			.find((h) => h.includes("<h1>AI: Follow-up question</h1>")) || "";
		check("child note created with the answer", html.includes("Follow-up question") && html.includes("CONTEXT-SEEN")
			&& html.includes("<table>") && html.includes('href="https://example.org/paper"') && html.includes("<h1>AI: Follow-up question</h1>"), html.slice(0, 500));
		check("note footer names the model", html.includes("claude-opus-5-5"));

		let saveChat = root.querySelector(".aichat-header .aichat-save-chat");
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
		input.dispatchEvent(new win.Event("input", { bubbles: true }));
		send.click();
		await waitFor(() => conv.messages[7]?.text.includes("slow chunk 1"), 15000, "slow stream to start");
		check("button shows Stop while streaming", send.classList.contains("aichat-stop") && send.title === "Stop" && !send.disabled);
		await screenshot(win, "02-library-streaming");
		send.click();
		await waitFor(() => !conv.busy, 10000, "stop");
		await sleep(200);
		check("answer marked stopped", conv.messages[7].status === "stopped");
		check("UI shows Stopped", root.textContent.includes("Stopped."));
		check("button back to Send", !send.classList.contains("aichat-stop") && send.dataset.icon === "send");
		check("Send is disabled while the box is empty", send.disabled);
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
		root.querySelector(".aichat-new-chat").click();
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
		readerRoot.querySelector(".aichat-new-chat").click();
		let reply = await ask(readerRoot, conv, "Question from the reader", 2);
		check("reply in reader", reply.status === "done" && reply.text.includes("CONTEXT-SEEN"), reply.error);
		let r = (await readRequests()).filter((x) => x.path === "/v1/messages").pop();
		check("reader context uses the open PDF", r.body.system[1].text.includes("QUANTUM-BANANA-42")
			&& r.body.system[1].text.includes("Attachment: "), r.body.system[1].text.slice(0, 400));
		checkLayout(win, ctxDetails, readerRoot, "reader side pane");
		await checkFillsPane(ctxDetails, AIChat.paneID, readerRoot, "reader side pane");
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

		// Layout: one label column in every section, fields beside it, nothing sticking out
		let paneRoot = doc.getElementById("zotero-ai-chat-prefs");
		let visible = (e) => e.getBoundingClientRect().width > 0;
		let labels = [...paneRoot.querySelectorAll(".form-grid > label")].filter(visible);
		let rights = labels.map((l) => Math.round(l.getBoundingClientRect().right));
		check("settings labels line up in one column", labels.length === 8 && Math.max(...rights) - Math.min(...rights) <= 1,
			labels.map((l, i) => `${l.value}${rights[i]}`).join(" "));
		let gridRight = Math.max(...[...paneRoot.querySelectorAll(".form-grid")].filter(visible).map((g) => g.getBoundingClientRect().right));
		let outside = [...paneRoot.querySelectorAll("input, textarea, menulist, button, checkbox, description")].filter(visible)
			.filter((e) => e.getBoundingClientRect().right > gridRight + 1);
		check("settings fields stay inside the form", !outside.length, outside.map((e) => e.id || e.localName).join(","));
		// (The Load models buttons sit beside their Model field, so they don't count)
		let starts = [...paneRoot.querySelectorAll("input, textarea, menulist, button, checkbox, .aichat-hint")]
			.filter((e) => visible(e) && !e.id.endsWith("-fetch"));
		let lefts = starts.map((e) => Math.round(e.getBoundingClientRect().left));
		check("every field starts at the same edge", starts.length >= 15 && Math.max(...lefts) - Math.min(...lefts) <= 1,
			starts.map((e, i) => `${e.id || e.localName}:${lefts[i]}`).join(" "));
		let fullWidth = ["anthropic-key", "anthropic-favorites", "anthropic-url", "anthropic-fetch", "custom"]
			.map((id) => doc.getElementById("zotero-ai-chat-" + id).getBoundingClientRect().right);
		check("full-width fields end at the same edge", Math.max(...fullWidth) - Math.min(...fullWidth) <= 1,
			fullWidth.map(Math.round).join(","));
		let fetchRect = doc.getElementById("zotero-ai-chat-anthropic-fetch").getBoundingClientRect();
		let modelRect = doc.getElementById("zotero-ai-chat-anthropic-model").getBoundingClientRect();
		check("Load models sits beside the Model field", fetchRect.left >= modelRect.right
			&& Math.abs((fetchRect.top + fetchRect.bottom) / 2 - (modelRect.top + modelRect.bottom) / 2) < 4,
		`button ${Math.round(fetchRect.left)},${Math.round(fetchRect.top)} field right ${Math.round(modelRect.right)} top ${Math.round(modelRect.top)}`);
		let testRect = doc.getElementById("zotero-ai-chat-test").getBoundingClientRect();
		let effortRect = doc.getElementById("zotero-ai-chat-anthropic-url").getBoundingClientRect();
		check("Test connection comes right after the service's fields", testRect.top > effortRect.bottom
			&& testRect.top < doc.getElementById("zotero-ai-chat-max-chars").getBoundingClientRect().top);
		let tokens = doc.getElementById("zotero-ai-chat-max-chars-tokens");
		check("full-text limit shows its size in tokens", tokens.value === "characters, about 50,000 tokens", tokens.value);
		await screenshot(prefWin, "05a-settings-claude-top");

		provider.value = "openai";
		provider.dispatchEvent(new prefWin.Event("command"));
		await sleep(100);
		check("switching provider saves pref", Zotero.Prefs.get("extensions.zotero-ai-chat.provider", true) === "openai");
		check("switching provider toggles sections",
			doc.getElementById("zotero-ai-chat-anthropic").hidden && !doc.getElementById("zotero-ai-chat-openai").hidden);
		await screenshot(prefWin, "05-settings-openai");
		for (let id of ["openrouter", "requesty"]) {
			provider.value = id;
			provider.dispatchEvent(new prefWin.Event("command"));
			check(`switching to ${id} shows only its section`,
				!doc.getElementById("zotero-ai-chat-" + id).hidden && doc.getElementById("zotero-ai-chat-anthropic").hidden
				&& doc.getElementById("zotero-ai-chat-openai").hidden);
		}
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
		check("token estimate follows the limit", tokens.value === "characters, about 37,500 tokens", tokens.value);
		maxChars.value = "0";
		maxChars.dispatchEvent(new prefWin.Event("input"));
		check("a limit of 0 says only metadata is sent", tokens.value === "characters: no full text, only the metadata", tokens.value);
		maxChars.value = "200000";
		maxChars.dispatchEvent(new prefWin.Event("input"));

		doc.getElementById("zotero-ai-chat-test").dispatchEvent(new prefWin.Event("command"));
		let result = doc.getElementById("zotero-ai-chat-test-result");
		await waitFor(() => result.textContent.startsWith("Connected"), 20000, "test connection result").catch(() => {});
		check("Test connection succeeds", result.textContent.startsWith("Connected") && result.textContent.includes("OK"), result.textContent);
		await screenshot(prefWin, "05b-settings-tested");
		provider.value = "openrouter";
		provider.dispatchEvent(new prefWin.Event("command"));
		check("switching service clears the old test result", result.textContent === "", result.textContent);
		provider.value = "anthropic";
		provider.dispatchEvent(new prefWin.Event("command"));
		let fav = doc.getElementById("zotero-ai-chat-anthropic-favorites");
		let originalFavorites = fav.value;
		check("favorites box lists the defaults", fav.value.split("\n").includes("claude-haiku-5-5"), JSON.stringify(fav.value));
		let modelField = doc.getElementById("zotero-ai-chat-anthropic-model");
		let available = doc.getElementById("zotero-ai-chat-anthropic-available");
		doc.getElementById("zotero-ai-chat-anthropic-fetch").dispatchEvent(new prefWin.Event("command"));
		await waitFor(() => !available.hidden, 15000, "fetched model list").catch(() => {});
		let ids = [...available.options].map((o) => o.value);
		check("Load models lists the server's models", ids.includes("claude-fable-5-1") && ids.includes("claude-haiku-5-5"), ids.join(","));
		available.value = "claude-fable-5-1";
		available.dispatchEvent(new prefWin.Event("change"));
		check("picking a fetched model sets the Model field and pref",
			modelField.value === "claude-fable-5-1" && Zotero.Prefs.get("extensions.zotero-ai-chat.anthropic.model", true) === "claude-fable-5-1");
		check("picked model is added to favorites", fav.value.split("\n").includes("claude-fable-5-1"));
		modelField.value = "claude-opus-5-5";
		modelField.dispatchEvent(new prefWin.Event("input"));
		fav.value = originalFavorites;
		fav.dispatchEvent(new prefWin.Event("input"));
		check("restored Model and favorites", Zotero.Prefs.get("extensions.zotero-ai-chat.anthropic.model", true) === "claude-opus-5-5"
			&& fav.value === originalFavorites);
		await screenshot(prefWin, "06-settings-claude");
		prefWin.close();
	});

	await step("model menu in the chat", async () => {
		await win.ZoteroPane.selectItem(item.id);
		let { root: menuRoot } = await openChat(win, details, AIChat.paneID);
		let select = await waitFor(() => menuRoot.querySelector(".aichat-model-select"), 5000, "model menu");
		let values = [...select.options].map((o) => o.value);
		check("model menu lists the favorite models",
			["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].every((m) => values.includes(m)), values.join(","));
		check("model menu shows the current model", select.value === "claude-opus-5-5", select.value);
		select.value = "claude-haiku-5-5";
		select.dispatchEvent(new win.Event("change", { bubbles: true }));
		check("choosing a model saves it", Zotero.Prefs.get("extensions.zotero-ai-chat.anthropic.model", true) === "claude-haiku-5-5");
		let reply = await ask(menuRoot, conv, "Which model are you?", 4);
		check("question completes with the chosen model", reply.status === "done", reply.error);
		let r = (await readRequests()).filter((x) => x.path === "/v1/messages").pop();
		check("request is sent with the chosen model", r.body.model === "claude-haiku-5-5", r.body.model);
		select.value = "claude-opus-5-5";
		select.dispatchEvent(new win.Event("change", { bubbles: true }));
		check("switching back saves the pref", Zotero.Prefs.get("extensions.zotero-ai-chat.anthropic.model", true) === "claude-opus-5-5");
		// A provider change made in Settings while the chat is open must update the menu right away;
		// otherwise picking from a stale list would save another service's model ID
		setPrefs({ provider: "openrouter" });
		await sleep(400);
		let other = [...select.options].map((o) => o.value);
		check("menu follows a provider change made in Settings", other.includes("openai/gpt-6-luna") && !other.includes("claude-haiku-5-5"), other.join(","));
		setPrefs({ provider: "anthropic", "openrouter.model": "minimax/minimax-m3.1-flash" });
		await sleep(400);
		check("menu follows the provider back", [...select.options].map((o) => o.value).includes("claude-haiku-5-5") && select.value === "claude-opus-5-5", select.value);
		await screenshot(win, "07-model-menu");
	});

	await step("OpenRouter and Requesty presets", async () => {
		await win.ZoteroPane.selectItem(item.id);
		let { root: presetRoot } = await openChat(win, details, AIChat.paneID);
		let presets = [
			["openrouter", "or-test-key", "minimax/minimax-m3.1-flash", "openai/gpt-6-luna"],
			["requesty", "rq-test-key", "alibaba/qwen3.8-max", "openai/gpt-6-luna"]
		];
		for (let [provider, key, model, favorite] of presets) {
			setPrefs({ provider, [`${provider}.apiKey`]: key, [`${provider}.baseURL`]: `http://127.0.0.1:${config.port}/v1`, [`${provider}.model`]: model });
			AIChat.clearConversation(conv);
			let reply = await ask(presetRoot, conv, `Hello via ${provider}`, 2);
			check(`${provider}: answer completes`, reply.status === "done" && reply.text.includes("CONTEXT-SEEN"), reply.error || reply.text.slice(0, 80));
			let r = (await readRequests()).filter((x) => x.path === "/v1/chat/completions").pop();
			check(`${provider}: sent to /chat/completions with its key and model`,
				r && r.headers.authorization === `Bearer ${key}` && r.body.model === model,
				r ? `${r.headers.authorization} ${r.body.model}` : "no request");
			let menu = presetRoot.querySelector(".aichat-model-select");
			let values = [...menu.options].map((o) => o.value);
			check(`${provider}: model menu shows its favorites`, values.includes(favorite) && values.includes(model), values.join(","));
		}
		setPrefs({ provider: "anthropic" });
	});

	await step("images: paste, crop, send", async () => {
		await win.ZoteroPane.selectItem(item.id);
		let { root: imgRoot } = await openChat(win, details, AIChat.paneID);
		AIChat.clearConversation(conv);
		setPrefs({ provider: "anthropic" });
		let input = imgRoot.querySelector(".aichat-input");
		let thumbs = () => imgRoot.querySelectorAll(".aichat-tray .aichat-thumb").length;

		let textPaste = pasteInto(AIChat, input, { files: [] });
		check("pasting plain text is left alone", !textPaste.defaultPrevented);

		let paste = pasteInto(AIChat, input, { files: [await makePNGFile(win, 200, 120, "#3366cc", "a.png")] });
		check("pasting an image is handled, not inserted as text", paste.defaultPrevented);
		await waitFor(() => conv.pendingImages.length === 1, 10000, "pasted image");
		await sleep(200);
		check("thumbnail shown in the tray", thumbs() === 1);
		check("pasted image stored as PNG", conv.pendingImages[0].mediaType === "image/png" && conv.pendingImages[0].data.startsWith("iVBOR"));
		check("small image keeps its size", conv.pendingImages[0].width === 200 && conv.pendingImages[0].height === 120);

		pasteInto(AIChat, input, { files: [await makePNGFile(win, 4000, 2500, "#cc3366", "big.png")] });
		await waitFor(() => conv.pendingImages.length === 2, 15000, "large pasted image");
		check("large image is scaled to 2000px", conv.pendingImages[1].width === 2000 && conv.pendingImages[1].height === 1250,
			`${conv.pendingImages[1].width}x${conv.pendingImages[1].height}`);

		let removeBtn = imgRoot.querySelector(".aichat-tray .aichat-remove");
		removeBtn.click();
		await waitFor(() => conv.pendingImages.length === 1, 5000, "remove");
		await sleep(200);
		check("remove button removes the image and its thumbnail", thumbs() === 1 && conv.pendingImages[0].width === 2000);

		// Ctrl+V with text on the clipboard is left to the normal paste
		Zotero.Utilities.Internal.copyTextToClipboard("some text");
		let textKey = new win.KeyboardEvent("keydown", { key: "v", ctrlKey: !Zotero.isMac, metaKey: Zotero.isMac, bubbles: true, cancelable: true });
		input.dispatchEvent(textKey);
		check("Ctrl+V with text on the clipboard pastes normally", !textKey.defaultPrevented);

		// A real image on the system clipboard. Headless sessions can only hold text there,
		// so these checks run only in a session with a real clipboard (HEADLESS=0).
		let realImage = await makePNGFile(win, 90, 70, "#ccaa33", "real.png");
		let wlCopy = Zotero.Prefs.get("extensions.uiharness.wlCopy", true);
		if (wlCopy) {
			// Another program owns the clipboard image, as with a screenshot tool
			const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
			let proc = await Subprocess.call({ command: wlCopy, arguments: ["--type", "image/png"], stdin: "pipe", environmentAppend: true });
			await proc.stdin.write(new Uint8Array(await realImage.arrayBuffer()));
			await proc.stdin.close();
			await proc.wait();
			await sleep(500);
			log("clipboard image placed with wl-copy");
		}
		else {
			await putImageOnClipboard(realImage);
		}
		if (AIChat.clipboardHasImage()) {
			let before = conv.pendingImages.length;
			let key = new win.KeyboardEvent("keydown", { key: "v", ctrlKey: !Zotero.isMac, metaKey: Zotero.isMac, bubbles: true, cancelable: true });
			input.dispatchEvent(key);
			check("Ctrl+V with an image on the clipboard is handled", key.defaultPrevented);
			await waitFor(() => conv.pendingImages.length === before + 1, 10000, "Ctrl+V image").catch(() => {});
			check("Ctrl+V attaches the clipboard image", conv.pendingImages.length === before + 1 && conv.pendingImages[before].width === 90,
				conv.pendingImages[before] ? `${conv.pendingImages[before].width}x${conv.pendingImages[before].height}` : "nothing attached");
			conv.pendingImages = conv.pendingImages.slice(0, before);
			AIChat.notify(conv);
		}
		else {
			log("clipboard image checks skipped: this session's clipboard can't hold images (run with HEADLESS=0)");
		}
		Zotero.Utilities.Internal.copyTextToClipboard("");

		// Crop tool: Esc cancels
		let cropBtn = imgRoot.querySelector(".aichat-crop");
		cropBtn.click();
		let overlay = await waitFor(() => win.document.querySelector(".aichat-crop-overlay"), 5000, "crop overlay");
		let ob = overlay.getBoundingClientRect();
		check("crop overlay covers the whole window", ob.left <= 1 && ob.top <= 1 && ob.width >= win.innerWidth - 1 && ob.height >= win.innerHeight - 1,
			`overlay ${Math.round(ob.left)},${Math.round(ob.top)} ${Math.round(ob.width)}x${Math.round(ob.height)} in window ${win.innerWidth}x${win.innerHeight}`);
		for (let [x, y] of [[300, 300], [700, 150], [win.innerWidth - 50, win.innerHeight / 2]]) {
			let hit = win.document.elementFromPoint(x, y);
			check(`a click at ${Math.round(x)},${Math.round(y)} reaches the overlay`, hit && overlay.contains(hit), hit ? hit.localName + "#" + hit.id : "nothing");
		}
		win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await waitFor(() => !win.document.querySelector(".aichat-crop-overlay"), 5000, "overlay closed by Esc");
		await sleep(300);
		check("Esc cancels without adding an image", conv.pendingImages.length === 1);

		// A tiny drag is ignored
		cropBtn.click();
		overlay = await waitFor(() => win.document.querySelector(".aichat-crop-overlay"), 5000, "crop overlay again");
		pointer(win, overlay, "pointerdown", 300, 300);
		pointer(win, overlay, "pointerup", 303, 302);
		await sleep(400);
		check("a tiny drag adds nothing", conv.pendingImages.length === 1 && !win.document.querySelector(".aichat-crop-overlay"));

		// Real crop
		cropBtn.click();
		overlay = await waitFor(() => win.document.querySelector(".aichat-crop-overlay"), 5000, "crop overlay third time");
		pointer(win, overlay, "pointerdown", 300, 400);
		pointer(win, overlay, "pointermove", 420, 460);
		pointer(win, overlay, "pointermove", 520, 520);
		let box = overlay.querySelector(".aichat-crop-box");
		check("selection box follows the drag", !box.hidden && box.style.width === "220px" && box.style.height === "120px", `${box.style.width} x ${box.style.height}`);
		pointer(win, overlay, "pointerup", 520, 520);
		await waitFor(() => conv.pendingImages.length === 2, 15000, "cropped image");
		let crop = conv.pendingImages[1];
		let dpr = win.devicePixelRatio || 1;
		check("overlay removed after the crop", !win.document.querySelector(".aichat-crop-overlay"));
		check("crop has the selected size", Math.abs(crop.width - 220 * dpr) <= 2 && Math.abs(crop.height - 120 * dpr) <= 2, `${crop.width}x${crop.height} dpr ${dpr}`);
		check("crop contains real pixels, not a blank image", crop.data.length > 600, crop.data.length);
		await sleep(200);
		check("two thumbnails in the tray", thumbs() === 2);

		// Send to Claude
		let reply = await ask(imgRoot, conv, "What does the figure show?", 2);
		check("answer completes and the model saw the images", reply.status === "done" && reply.text.includes("IMAGE-SEEN"), reply.error || reply.text.slice(0, 80));
		let r = (await readRequests()).filter((x) => x.path === "/v1/messages").pop();
		let content = r.body.messages[0].content;
		check("request: two image blocks then the text", Array.isArray(content) && content.length === 3
			&& content[0].type === "image" && content[1].type === "image" && content[2].type === "text"
			&& content[2].text === "What does the figure show?", JSON.stringify(content).slice(0, 200));
		check("request: base64 PNG data with the right media type", content[0].source.type === "base64" && content[0].source.media_type === "image/png"
			&& content[0].source.data.startsWith("iVBOR") && !JSON.stringify(r.body).includes("dataURL"));
		await sleep(250);
		check("tray emptied after sending", thumbs() === 0 && imgRoot.querySelector(".aichat-tray").hidden);
		check("question bubble shows the thumbnails", imgRoot.querySelectorAll(".aichat-user .aichat-thumb").length === 2);
		await screenshot(win, "08-images");

		// Follow-up keeps the images in the conversation
		await ask(imgRoot, conv, "And the second one?", 4);
		let followUp = (await readRequests()).filter((x) => x.path === "/v1/messages").pop();
		check("follow-up still includes the earlier images", Array.isArray(followUp.body.messages[0].content)
			&& followUp.body.messages[0].content.filter((b) => b.type === "image").length === 2);

		// An OpenAI-compatible service gets image_url parts
		setPrefs({ provider: "openrouter", "openrouter.apiKey": "or-test-key", "openrouter.baseURL": `http://127.0.0.1:${config.port}/v1` });
		AIChat.clearConversation(conv);
		pasteInto(AIChat, input, { files: [await makePNGFile(win, 80, 60, "#33cc66", "c.png")] });
		await waitFor(() => conv.pendingImages.length === 1, 10000, "image for OpenRouter");
		let reply2 = await ask(imgRoot, conv, "Describe it", 2);
		check("OpenAI-compatible answer saw the image", reply2.status === "done" && reply2.text.includes("IMAGE-SEEN"), reply2.error || reply2.text.slice(0, 80));
		let o = (await readRequests()).filter((x) => x.path === "/v1/chat/completions").pop();
		let last = o.body.messages[o.body.messages.length - 1].content;
		check("request: text part and image_url data URL", Array.isArray(last) && last[0].type === "text" && last[1].type === "image_url"
			&& last[1].image_url.url.startsWith("data:image/png;base64,iVBOR"), JSON.stringify(last).slice(0, 160));
		setPrefs({ provider: "anthropic" });

		// An image saved in a note is mentioned
		let saveBtn = [...imgRoot.querySelectorAll(".aichat-actions .aichat-save-note")].pop();
		let before = item.getNotes().length;
		saveBtn.click();
		await waitFor(() => item.getNotes().length === before + 1, 10000, "note with image mention");
		let noteHTML = Zotero.Items.get(item.getNotes()).map((n) => n.getNote()).find((h) => h.includes("Describe it")) || "";
		check("note says an image was attached", noteHTML.includes("[1 image attached]"), noteHTML.slice(0, 200));
	});

	await step("chat history", async () => {
		setPrefs({ provider: "anthropic" });
		await win.ZoteroPane.selectItem(item.id);
		let { root: hRoot } = await openChat(win, details, AIChat.paneID);
		conv = AIChat.getConversation(item);
		let file = PathUtils.join(Zotero.DataDirectory.dir, "ai-chat", `${item.libraryID}_${item.key}.json`);
		let readFile = async () => (await IOUtils.readJSON(file)).chats;
		let rowTitles = () => [...hRoot.querySelectorAll(".aichat-history-title")].map((t) => t.textContent);

		hRoot.querySelector(".aichat-new-chat").click();
		await ask(hRoot, conv, "History one", 2);
		let chats = await waitFor(async () => {
			let c = await readFile();
			return c[0]?.title === "History one" && c;
		}, 5000, "history file");
		check("chat is saved in the data directory after the answer",
			chats[0].messages.length === 2 && chats[0].messages[1].text.includes("CONTEXT-SEEN"), file);
		check("header shows the chat's title", hRoot.querySelector(".aichat-chat-title").textContent === "History one",
			hRoot.querySelector(".aichat-chat-title").textContent);
		let firstID = conv.chatID;

		hRoot.querySelector(".aichat-new-chat").click();
		check("New chat resets the title", hRoot.querySelector(".aichat-chat-title").textContent === "New chat");
		await ask(hRoot, conv, "History two", 2);

		hRoot.querySelector(".aichat-history-toggle").click();
		let rows = await waitFor(() => {
			let r = hRoot.querySelectorAll(".aichat-history-row");
			return r.length >= 2 && r;
		}, 5000, "history rows");
		let titles = rowTitles();
		check("history lists the item's chats, newest first", titles[0] === "History two" && titles[1] === "History one"
			&& titles.includes("What is the marker?"), titles.join(" | "));
		check("the open chat is highlighted", rows[0].classList.contains("aichat-current") && !rows[1].classList.contains("aichat-current"));
		check("the list replaces the messages while open",
			hRoot.querySelector(".aichat-messages").hidden && !hRoot.querySelector(".aichat-history").hidden);
		let meta = rows[1].querySelector(".aichat-history-meta").textContent;
		check("rows show the question count and when", meta.startsWith("1 question · today"), meta);
		checkLayout(win, details, hRoot, "history list");
		await screenshot(win, "09-history");

		rows[1].querySelector(".aichat-history-open").click();
		await waitFor(() => conv.chatID === firstID && !hRoot.querySelector(".aichat-messages").hidden, 5000, "chat opened");
		await sleep(200);
		check("opening a saved chat shows its messages", conv.messages.length === 2
			&& hRoot.querySelectorAll(".aichat-msg").length === 2
			&& hRoot.querySelector(".aichat-user .aichat-bubble")?.textContent === "History one");
		await ask(hRoot, conv, "History one follow-up", 4);
		let r = (await readRequests()).filter((x) => x.path === "/v1/messages").pop();
		check("continuing a saved chat sends its earlier messages", r.body.messages.length === 3
			&& r.body.messages[0].content === "History one" && r.body.messages[2].content === "History one follow-up",
			JSON.stringify(r.body.messages).slice(0, 200));

		hRoot.querySelector(".aichat-history-toggle").click();
		await waitFor(() => rowTitles()[0] === "History one", 5000, "continued chat moves to the top");
		let twoRow = [...hRoot.querySelectorAll(".aichat-history-row")]
			.find((row) => row.querySelector(".aichat-history-title").textContent === "History two");
		let del = twoRow.querySelector(".aichat-history-delete");
		del.click();
		check("the first delete click asks for confirmation", del.classList.contains("aichat-confirm") && del.textContent === "Delete");
		await screenshot(win, "10-history-delete");
		del.click();
		await waitFor(async () => !(await readFile()).some((c) => c.title === "History two"), 5000, "chat deleted from the file");
		await waitFor(() => !rowTitles().includes("History two"), 5000, "row removed");
		check("a deleted chat leaves the list and the file", !rowTitles().includes("History two"));
		check("deleting another chat keeps the open one", conv.chatID === firstID && conv.messages.length === 4);
		hRoot.querySelector(".aichat-history-toggle").click();
		check("the list closes again", !hRoot.querySelector(".aichat-messages").hidden && hRoot.querySelector(".aichat-history").hidden);

		// A chat with an image survives a restart
		hRoot.querySelector(".aichat-new-chat").click();
		pasteInto(AIChat, hRoot.querySelector(".aichat-input"), { files: [await makePNGFile(win, 64, 48, "#aa33cc", "h.png")] });
		await waitFor(() => conv.pendingImages.length === 1, 10000, "image for the history chat");
		await ask(hRoot, conv, "History image", 2);
		let imageChatID = conv.chatID;
		await waitFor(async () => (await readFile())[0]?.id === imageChatID, 5000, "image chat saved");
		let saved = (await readFile())[0];
		check("the saved chat keeps the image", saved.messages[0].images.length === 1
			&& saved.messages[0].images[0].data.startsWith("iVBOR") && saved.messages[0].images[0].width === 64
			&& !JSON.stringify(saved).includes("dataURL"));

		// Like a restart: forget what's in memory, then show the item again
		await win.ZoteroPane.selectItem(item2.id);
		AIChat.conversations.clear();
		AIChat.historyCache.clear();
		AIChat.lastChatIDs.clear();
		await win.ZoteroPane.selectItem(item.id);
		await details.scrollToPane(AIChat.paneID, "instant");
		let restored = await waitFor(() => {
			let c = AIChat.conversations.get(item.id);
			return c && c.messages.length === 2 && c;
		}, 10000, "chat restored from disk");
		await sleep(250);
		check("the latest chat reopens after a restart", restored.chatID === imageChatID && restored.messages[0].text === "History image");
		check("its image is shown again", hRoot.querySelectorAll(".aichat-user .aichat-thumb").length === 1);
		await ask(hRoot, restored, "History image follow-up", 4);
		r = (await readRequests()).filter((x) => x.path === "/v1/messages").pop();
		check("a restored image is sent again with a follow-up", Array.isArray(r.body.messages[0].content)
			&& r.body.messages[0].content[0].type === "image" && r.body.messages[0].content[0].source.data.startsWith("iVBOR"));
		conv = restored;

		// Turned off: nothing new is saved, and the history button says why
		setPrefs({ saveHistory: false });
		await sleep(100);
		let before = JSON.stringify(await readFile());
		hRoot.querySelector(".aichat-new-chat").click();
		await ask(hRoot, conv, "Not saved", 2);
		await sleep(300);
		check("with history off, chats aren't saved", JSON.stringify(await readFile()) === before);
		hRoot.querySelector(".aichat-history-toggle").click();
		check("with history off, the history button explains", hRoot.querySelector(".aichat-history").hidden
			&& hRoot.querySelector(".aichat-context").textContent.includes("turned off"), hRoot.querySelector(".aichat-context").textContent);
		setPrefs({ saveHistory: true });

		// Deleting an item deletes its chats
		let temp = new Zotero.Item("book");
		temp.setField("title", "Temporary Book");
		await temp.saveTx();
		await win.ZoteroPane.selectItem(temp.id);
		await openChat(win, details, AIChat.paneID);
		let tconv = AIChat.getConversation(temp);
		await ask(hRoot, tconv, "Short-lived", 2);
		let tfile = PathUtils.join(Zotero.DataDirectory.dir, "ai-chat", `${temp.libraryID}_${temp.key}.json`);
		await waitFor(() => IOUtils.exists(tfile), 5000, "history file for the temporary item");
		await temp.eraseTx();
		await waitFor(async () => !(await IOUtils.exists(tfile)), 5000, "history file removed").catch(() => {});
		check("deleting an item deletes its saved chats", !(await IOUtils.exists(tfile)));
		check("other items' chats are untouched", await IOUtils.exists(file));
		await win.ZoteroPane.selectItem(item.id);
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
		let conv3 = await waitFor(() => {
			let c = again.conversations.get(item.id);
			return c && c.historyChecked && !c.restoring && c;
		}, 10000, "restored conversation");
		check("the saved chat comes back after the plugin restarts", conv3.messages.length === 4
			&& conv3.messages[0].text === "History image", conv3.messages.map((m) => (m.text || "").slice(0, 24)).join(" | "));
		let reply = await ask(newRoot, conv3, "After re-enable", conv3.messages.length + 2);
		check("chat works after re-enable", reply.status === "done", reply.error);
	});

	await step("delete all chat history from settings", async () => {
		let plugin = Zotero.AIChat;
		Zotero.Utilities.Internal.openPreferences(plugin.prefPaneID);
		let prefWin = await waitFor(() => Services.wm.getMostRecentWindow("zotero:pref"), 20000, "preferences window");
		let doc = prefWin.document;
		let button = await waitFor(() => doc.getElementById("zotero-ai-chat-clear-history"), 20000, "delete history button");
		let checkbox = doc.getElementById("zotero-ai-chat-save-history");
		await waitFor(() => checkbox.checked, 5000, "history checkbox").catch(() => {});
		check("history checkbox reflects the pref", checkbox.checked === true);
		let services = [...doc.querySelectorAll("#zotero-ai-chat-provider menuitem")].map((m) => m.getAttribute("label"));
		check("Service menu lists Claude, OpenRouter, Requesty, then other OpenAI-compatible APIs",
			services.length === 4 && services[0].startsWith("Claude") && services[1] === "OpenRouter" && services[2] === "Requesty"
			&& services[3].startsWith("Other OpenAI-compatible"), services.join(" | "));
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "ai-chat");
		check("history folder exists before deleting", await IOUtils.exists(dir));
		button.dispatchEvent(new prefWin.Event("command"));
		await sleep(200);
		check("the first click asks for confirmation", button.getAttribute("label").startsWith("Click again") && await IOUtils.exists(dir));
		button.scrollIntoView();
		await sleep(300);
		await screenshot(prefWin, "11-settings-history");
		button.dispatchEvent(new prefWin.Event("command"));
		let result = doc.getElementById("zotero-ai-chat-clear-history-result");
		await waitFor(() => result.textContent.includes("deleted"), 10000, "delete result").catch(() => {});
		check("the second click deletes all chat history", result.textContent === "All chat history was deleted."
			&& !(await IOUtils.exists(dir)), result.textContent);
		check("open chats are emptied too", plugin.getConversation(item).messages.length === 0);
		prefWin.close();
	});

	await step("maths (LaTeX) in answers and notes", async () => {
		// Runs after the re-enable step, so KaTeX is loaded by the restarted plugin
		let plugin = Zotero.AIChat;
		let paper = new Zotero.Item("journalArticle");
		paper.setField("title", "Maths Paper");
		await paper.saveTx();
		await win.ZoteroPane.selectItem(paper.id);
		let { root: mroot } = await openChat(win, details, plugin.paneID);
		let mconv = plugin.getConversation(paper);
		let reply = await ask(mroot, mconv, "MATH please", 2);
		check("maths answer completed", reply.status === "done", reply.status + " " + (reply.error || ""));

		let answer = [...mroot.querySelectorAll(".aichat-assistant .aichat-answer")].pop();
		let formulas = answer.querySelectorAll(".katex");
		let displays = answer.querySelectorAll(".katex-display");
		check("formulas rendered by KaTeX (5 inline, 2 displayed)", formulas.length === 7 && displays.length === 2,
			`${formulas.length} formulas, ${displays.length} displayed`);
		check("the broken formula is shown as written", answer.querySelector(".aichat-math-error")?.textContent === "\\(\\frac{a\\)",
			answer.querySelector(".aichat-math-error")?.outerHTML);
		let visible = answer.cloneNode(true);
		visible.querySelectorAll(".katex-mathml, .aichat-math-error").forEach((e) => e.remove());
		check("no LaTeX source left in the visible text", !visible.textContent.includes("\\"), visible.textContent.slice(0, 300));
		check("prices stay text", visible.textContent.includes("a run costs $5 and $10 with"), visible.textContent.slice(0, 300));

		let font = win.getComputedStyle(formulas[0]).fontFamily;
		check("KaTeX stylesheet applied", /^"?KaTeX_Main/.test(font), font);
		check("formulas use the answer's text colour (light and dark)",
			win.getComputedStyle(formulas[0]).color === win.getComputedStyle(answer).color, win.getComputedStyle(formulas[0]).color);
		let mathml = formulas[0].querySelector(".katex-mathml math");
		check("MathML copy for screen readers is present but not drawn", !!mathml
			&& formulas[0].querySelector(".katex-mathml").getBoundingClientRect().width <= 1);
		let strut = formulas[0].querySelector(".katex-strut");
		check("KaTeX's sizing styles survived", !!strut?.style.height, strut?.getAttribute("style"));
		check("square roots and arrows are drawn (SVG)", answer.querySelectorAll(".katex-html svg path").length >= 2,
			answer.querySelectorAll(".katex-html svg").length);

		await win.document.fonts.ready;
		let faces = [...win.document.fonts].filter((f) => f.family.replace(/"/g, "").startsWith("KaTeX_"));
		let loaded = faces.filter((f) => f.status === "loaded").map((f) => `${f.family.replace(/"/g, "")} ${f.style}`);
		let failed = faces.filter((f) => f.status === "error").map((f) => f.family);
		check("KaTeX fonts load from the plugin", loaded.some((f) => f.startsWith("KaTeX_Main"))
			&& loaded.some((f) => f.startsWith("KaTeX_Math")) && !failed.length,
		`loaded: ${loaded.join(", ")}; failed: ${failed.join(", ")}`);

		let wide = displays[1];
		check("a wide equation scrolls inside the answer", wide.scrollWidth > wide.clientWidth + 50
			&& wide.getBoundingClientRect().right <= details.getBoundingClientRect().right + 1,
		`${wide.scrollWidth} in ${wide.clientWidth}`);
		checkLayout(win, details, mroot, "maths answer");

		// Copying selected text gives the formulas as LaTeX, not KaTeX's text twice over.
		// The selection starts inside the first formula, which is then copied whole.
		let sel = win.getSelection();
		let firstLetter = formulas[0].querySelector(".katex-html .mord.mathnormal").firstChild;
		sel.removeAllRanges();
		let range = win.document.createRange();
		range.setStart(firstLetter, 0);
		range.setEndAfter(answer.querySelector(".katex-display").parentNode);
		sel.addRange(range);
		win.document.execCommand("copy");
		sel.removeAllRanges();
		let copied = readClipboardText();
		check("copied selection has the formulas as LaTeX", copied.startsWith("$L_{\\text{img}}$ and $L_{\\text{unc}}$:\n\n")
			&& copied.includes("\n$\\tilde C$: render after the appearance adjustment.\n")
			&& copied.includes("a run costs $5 and $10 with $x_i^2$ terms.")
			&& copied.endsWith("$$L_{\\text{DINO}}\n=\\min\\!\\left(1,\\;2-2\\cos(\\tilde D,D)\\right),\n\\qquad\nL_{\\text{uncertainty}}\n"
				+ "=\\frac{L_{\\text{DINO}}}{2\\sigma^2}\n+\\lambda_{\\text{prior}}\\log\\sigma .$$"), copied);
		let plainRange = win.document.createRange();
		plainRange.selectNodeContents(answer.querySelector("li strong"));
		sel.addRange(plainRange);
		win.document.execCommand("copy");
		sel.removeAllRanges();
		check("copying text without formulas is unchanged", readClipboardText() === "after", readClipboardText());

		displays[0].scrollIntoView({ block: "center" });
		await sleep(300);
		await screenshot(win, "12-maths");

		// Saved as a note, the maths is in the note editor's format, and the editor draws it
		mroot.querySelector(".aichat-assistant .aichat-save-note").click();
		await waitFor(() => paper.getNotes().length === 1, 10000, "maths note saved");
		let note = Zotero.Items.get(paper.getNotes()[0]);
		let html = note.getNote();
		check("note stores the maths for Zotero's note editor", html.includes('<span class="math">$L_{\\text{img}}$</span>')
			&& (html.match(/<pre class="math">\$\$/g) || []).length === 2 && !html.includes("katex"), html.slice(0, 900));
		await win.ZoteroPane.selectItem(note.id);
		// (The reader tab has a note editor too, so look at all of them)
		let rendered = await waitFor(() => {
			let counts = [...win.document.querySelectorAll("note-editor")].map((editor) => {
				let doc = editor.querySelector("iframe")?.contentDocument;
				return doc?.body?.textContent.includes("The loss has two parts") ? doc.querySelectorAll(".katex").length : 0;
			});
			return Math.max(0, ...counts) >= 7 ? Math.max(...counts) : 0;
		}, 15000, "maths drawn in the note editor").catch((e) => String(e));
		check("Zotero's note editor draws the saved maths", typeof rendered === "number", rendered);
		await sleep(500);
		await screenshot(win, "13-maths-note");
	});

	await step("chat moved to the top of the item pane", async () => {
		// As when you move AI Chat up in the side bar: Zotero saves the order and moves the
		// sections' elements, which takes ours out of the page and puts it back
		let plugin = Zotero.AIChat;
		let originalOrder = Zotero.Prefs.get("sidenav.order") || "";
		Zotero.Prefs.set("sidenav.order", [plugin.paneID, "info", "abstract", "attachments", "notes", "note-info",
			"attachment-info", "attachment-annotations", "libraries-collections", "tags", "related"].join(","));
		await sleep(500);
		let scroller = details.querySelector("#zotero-view-item");
		let chatShown = async (container, label, expected) => {
			let section = await waitFor(() => findSection(container, plugin.paneID), 10000, "chat section").catch(() => null);
			let root = await waitFor(() => section?.querySelector(".aichat-root"), 5000, "chat UI").catch(() => null);
			let conv = root && plugin.conversations.get(container === details ? item.id : item.id);
			if (root && expected) {
				await waitFor(() => root.querySelectorAll(".aichat-msg").length === expected, 5000, "messages").catch(() => {});
			}
			check(`chat shown with AI Chat at the top (${label})`, !!root
				&& (!expected || root.querySelectorAll(".aichat-msg").length === expected),
			root ? `${root.querySelectorAll(".aichat-msg").length} messages` : "section is empty");
			return root;
		};

		await win.ZoteroPane.selectItem(item.id);
		let topRoot = await chatShown(details, "after moving it");
		check("AI Chat is the first section", scroller.firstElementChild?.dataset.pane === plugin.paneID,
			scroller.firstElementChild?.dataset.pane);
		let topConv = plugin.getConversation(item);
		if (topRoot) await ask(topRoot, topConv, "Question with the chat at the top", topConv.messages.length + 2);
		let count = topConv.messages.length;
		await win.ZoteroPane.selectItem(item2.id);
		await sleep(300);
		await win.ZoteroPane.selectItem(item.id);
		await chatShown(details, "switching items", count);

		// A new reader tab gets a new side pane, whose sections are put in order once added
		for (let tab of win.Zotero_Tabs._tabs.filter((t) => t.type === "reader")) win.Zotero_Tabs.close(tab.id);
		await sleep(500);
		let reader = await Zotero.Reader.open(att.id);
		await waitFor(() => win.Zotero_Tabs.selectedType === "reader", 20000, "reader tab");
		if (win.ZoteroContextPane.collapsed) win.ZoteroContextPane.togglePane();
		let ctxDetails = await waitFor(() => win.document.getElementById(reader.tabID + "-context"), 20000, "reader item pane");
		await sleep(1000);
		await chatShown(ctxDetails, "new reader tab", count);
		await screenshot(win, "14-chat-at-top-reader");
		win.Zotero_Tabs.select("zotero-pane");
		await sleep(300);

		// Restarting the plugin (as an update does) adds the section again
		const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
		let addon = await AddonManager.getAddonByID("zotero-ai-chat@suresh-inbit");
		await addon.disable();
		await waitFor(() => !Zotero.AIChat, 10000, "plugin shut down");
		await addon.enable();
		plugin = await waitFor(() => Zotero.AIChat, 15000, "plugin restarted");
		await sleep(1000);
		await win.ZoteroPane.selectItem(item.id);
		await sleep(500);
		await chatShown(details, "after the plugin restarts, its saved chat comes back", count);
		await win.ZoteroPane.selectItem(item2.id);
		await sleep(300);
		await win.ZoteroPane.selectItem(item.id);
		await chatShown(details, "after restarting and switching items", count);
		await screenshot(win, "15-chat-at-top-library");
		// The PDF tab stayed open while the plugin restarted
		win.Zotero_Tabs.select(reader.tabID);
		await waitFor(() => win.Zotero_Tabs.selectedType === "reader", 10000, "reader tab").catch(() => {});
		await sleep(1000);
		let readerRoot = await chatShown(ctxDetails, "PDF tab open while the plugin restarted", count);
		check("that PDF tab's chat is drawn by the restarted plugin",
			!!readerRoot && [...plugin.views.keys()].includes(readerRoot.parentElement));
		win.Zotero_Tabs.select("zotero-pane");
		await sleep(300);
		Zotero.Prefs.set("sidenav.order", originalOrder);
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
