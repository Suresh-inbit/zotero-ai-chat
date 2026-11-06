/* global Zotero, Services, IOUtils, ChromeUtils, setTimeout */
// Reinstall test, used by tests/run_reinstall_test.sh. Zotero starts with an older build
// of the plugin; this installs the new build over it without restarting (as Tools >
// Plugins > Install Plugin From File does), opens the crop tool and records its geometry.
// Catches stale styles: Gecko caches stylesheets by URL, and the XPI path never changes.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
async function waitFor(fn, t = 20000) { let s = Date.now(); while (Date.now() - s < t) { try { let v = await fn(); if (v) return v; } catch (e) {} await sleep(100); } throw new Error("timeout"); }
async function run() {
	await Zotero.uiReadyPromise;
	let win = await waitFor(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView && Zotero.getMainWindow());
	win.resizeTo(1400, 900);
	await sleep(1500);
	let old = Zotero.AIChat;
	out.oldVersion = old?.version;
	out.oldVersionLoaded = !!old && old.version !== Zotero.Prefs.get("extensions.reinstalltest.newVersion", true);
	// AI Chat moved to the top of the item pane, as in the side bar
	Zotero.Prefs.set("sidenav.order", [old.paneID, "info", "abstract", "attachments", "notes", "note-info", "attachment-info",
		"attachment-annotations", "libraries-collections", "tags", "related"].join(","));
	let item = new Zotero.Item("journalArticle"); item.setField("title", "Repro"); await item.saveTx();
	let att = await Zotero.Attachments.importFromFile({ file: Zotero.Prefs.get("extensions.reinstalltest.pdf", true), parentItemID: item.id });
	// A saved chat, in builds that have chat history
	if (typeof old.persistChat === "function") {
		let conv = old.getConversation(item);
		conv.messages.push({ role: "user", text: "Saved question", images: [] },
			{ role: "assistant", text: "Saved answer", status: "done", model: "m" });
		conv.restoring = false;
		await old.persistChat(conv);
		out.savedChat = true;
	}
	await win.ZoteroPane.selectItem(item.id);
	await sleep(1000);
	// A PDF tab stays open through the update
	let reader = await Zotero.Reader.open(att.id);
	await waitFor(() => win.Zotero_Tabs.selectedType === "reader");
	if (win.ZoteroContextPane.collapsed) win.ZoteroContextPane.togglePane();
	await waitFor(() => win.document.getElementById(reader.tabID + "-context"));
	await sleep(1500);
	win.Zotero_Tabs.select("zotero-pane");
	await sleep(500);
	// Install the new build over the running old one, like Tools > Plugins > Install Plugin From File
	const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
	let install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(Zotero.Prefs.get("extensions.reinstalltest.newXpi", true)));
	await install.install();
	let plugin = await waitFor(() => Zotero.AIChat && Zotero.AIChat !== old && Zotero.AIChat);
	out.newVersionLoaded = true;
	await sleep(1000);

	// The PDF tab that was open through the update shows the chat, with its saved history.
	// Browse the library first, then look at the tab shortly after switching to it, as you
	// would; given long enough, a later refresh in Zotero can hide the problem
	let other = new Zotero.Item("book"); other.setField("title", "Other"); await other.saveTx();
	await win.ZoteroPane.selectItem(other.id);
	await sleep(500);
	await win.ZoteroPane.selectItem(item.id);
	await sleep(500);
	win.Zotero_Tabs.select(reader.tabID);
	await waitFor(() => win.Zotero_Tabs.selectedType === "reader");
	await sleep(1500);
	let ctx = win.document.getElementById(reader.tabID + "-context");
	let readerRoot = [...ctx.querySelectorAll("item-pane-custom-section")]
		.find((e) => e.dataset.pane === plugin.paneID)?.querySelector(".aichat-root");
	// Drawn by the new build: an old build's leftover section can still draw a chat with the
	// old, stopped copy's code, or (as reported) stay empty
	out.readerChat = !!readerRoot && [...plugin.views.keys()].includes(readerRoot.parentElement);
	out.readerMessages = readerRoot ? readerRoot.querySelectorAll(".aichat-msg").length : null;
	out.readerFirst = ctx.querySelector("#zotero-view-item")?.firstElementChild?.dataset.pane === plugin.paneID;
	win.Zotero_Tabs.select("zotero-pane");
	await sleep(500);
	let details = win.document.getElementById("zotero-item-details");
	await win.ZoteroPane.selectItem(item.id);
	let section = await waitFor(() => [...details.querySelectorAll("item-pane-custom-section")].find((e) => e.dataset.pane === plugin.paneID));
	await details.scrollToPane(plugin.paneID, "instant");
	let root = await waitFor(() => section.querySelector(".aichat-root"));
	let composer = await waitFor(() => root.querySelector(".aichat-composer"));
	out.composerRadius = win.getComputedStyle(composer).borderTopLeftRadius;
	let crop = await waitFor(() => root.querySelector(".aichat-crop"));
	crop.click();
	let overlay = await waitFor(() => win.document.querySelector(".aichat-crop-overlay"));
	await sleep(300);
	let r = overlay.getBoundingClientRect();
	let cs = win.getComputedStyle(overlay);
	out.overlay = { left: r.left, top: r.top, width: r.width, height: r.height, position: cs.position, zIndex: cs.zIndex, background: cs.backgroundColor };
	out.window = { w: win.innerWidth, h: win.innerHeight };
	let hint = overlay.querySelector(".aichat-crop-hint");
	out.hintPosition = win.getComputedStyle(hint).position;
	win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	await sleep(300);

	// Maths: KaTeX and its fonts come from inside the new XPI, at the same path as the old one
	let conv = plugin.getConversation(item);
	conv.messages.push({ role: "user", text: "q" },
		{ role: "assistant", text: "Inline \\(x^2\\) and \\[\\frac{a}{b}\\]", status: "done" });
	[...plugin.views.values()].forEach((view) => view.renderAll());
	// (The last answer: with chat history the saved one comes first)
	let answer = await waitFor(() => [...root.querySelectorAll(".aichat-answer")].pop()?.querySelector(".katex")
		&& [...root.querySelectorAll(".aichat-answer")].pop(), 10000).catch(() => null);
	out.formulas = answer ? answer.querySelectorAll(".katex").length : 0;
	await win.document.fonts.ready;
	let faces = [...win.document.fonts].filter((f) => f.family.replace(/"/g, "").startsWith("KaTeX_"));
	out.katexFontsLoaded = faces.filter((f) => f.status === "loaded").length;
	out.katexFontsFailed = faces.filter((f) => f.status === "error").length;
}
function startup() {
	run().catch((e) => { out.error = String(e); }).finally(async () => {
		await IOUtils.writeUTF8(Zotero.Prefs.get("extensions.reinstalltest.out", true), JSON.stringify(out, null, 1));
		Services.startup.quit(Services.startup.eForceQuit);
	});
}
function shutdown() {} function install() {} function uninstall() {}
