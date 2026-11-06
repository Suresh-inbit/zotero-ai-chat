/* global Zotero, Services, IOUtils, PathUtils, ChromeUtils, setTimeout */
// Upgrade test, used by tests/run_upgrade_test.sh. Runs twice in one throwaway profile:
//   1. Zotero starts with an older build (default 1.3.1). With AI Chat moved to the top of
//      the item pane, two items get saved chats (one with a large image) and a PDF tab is
//      opened. Then the new build is installed over the running old one, and the chats must
//      show in the library and in the PDF tab that stayed open.
//   2. Zotero restarts with the new build, restoring the PDF tab: the chats must show again.
// Writes the checks to the JSON file in the extensions.upgradetest.out pref.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: String(detail) });

async function waitFor(fn, timeout = 20000) {
	let start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			let value = await fn();
			if (value) return value;
		}
		catch (e) {}
		await sleep(100);
	}
	return null;
}

function findSection(container, paneID) {
	return [...container.querySelectorAll("item-pane-custom-section")].find((e) => e.dataset.pane === paneID);
}

// The chat in a pane, drawn by the running build, with the item's saved chat in it. Looked at
// shortly after the pane is shown, as you would: given long enough, a later refresh in
// Zotero can hide a pane that wasn't drawn.
async function checkChat(container, plugin, title, label) {
	await sleep(800);
	let section = findSection(container, plugin.paneID);
	let body = section?.querySelector('[data-type="body"]');
	let root = section?.querySelector(".aichat-root");
	let ours = !!root && [...plugin.views.keys()].includes(root.parentElement);
	if (ours) await waitFor(() => root.querySelectorAll(".aichat-msg").length === 2, 5000);
	let messages = root ? root.querySelectorAll(".aichat-msg").length : 0;
	check(`${label}: the chat is shown, with its saved messages`,
		ours && messages === 2 && root.querySelector(".aichat-chat-title")?.textContent === "First question about " + title,
		!section ? "no AI Chat section" : !root ? `AI Chat is empty (${body?.children.length} elements in it)`
			: !ours ? "drawn by the old build's leftover section" : `${messages} messages, "${root.querySelector(".aichat-chat-title")?.textContent}"`);
	check(`${label}: AI Chat is first in the pane`,
		container.querySelector("#zotero-view-item")?.firstElementChild?.dataset.pane === plugin.paneID);
}

async function openReader(win, attID) {
	let reader = await Zotero.Reader.open(attID);
	await waitFor(() => win.Zotero_Tabs.selectedType === "reader");
	if (win.ZoteroContextPane.collapsed) win.ZoteroContextPane.togglePane();
	await waitFor(() => win.document.getElementById(reader.tabID + "-context"));
	return reader;
}

async function beforeAndDuringUpdate(win) {
	let old = Zotero.AIChat;
	check("the old build is running", !!old && typeof old.persistChat === "function", old?.version);
	if (!old || typeof old.persistChat !== "function") return;
	Zotero.Prefs.set("sidenav.order", [old.paneID, "info", "abstract", "attachments", "notes", "note-info",
		"attachment-info", "attachment-annotations", "libraries-collections", "tags", "related"].join(","));

	let a = new Zotero.Item("preprint");
	a.setField("title", "Paper A");
	await a.saveTx();
	let att = await Zotero.Attachments.importFromFile({ file: Zotero.Prefs.get("extensions.upgradetest.pdf", true), parentItemID: a.id });
	let b = new Zotero.Item("preprint");
	b.setField("title", "Paper B");
	await b.saveTx();

	// A large image, like a cropped figure, makes Paper A's chat file about half a megabyte
	let canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = 1600;
	canvas.height = 1200;
	let ctx = canvas.getContext("2d");
	for (let i = 0; i < 4000; i++) {
		ctx.fillStyle = `hsl(${i % 360},70%,50%)`;
		ctx.fillRect(Math.random() * 1600, Math.random() * 1200, 30, 30);
	}
	let dataURL = canvas.toDataURL("image/png");
	for (let [item, title, withImage] of [[a, "Paper A", true], [b, "Paper B", false]]) {
		let conv = old.getConversation(item);
		let images = withImage ? [{ id: "img1", mediaType: "image/png", data: dataURL.split(",")[1], dataURL, width: 1600, height: 1200 }] : [];
		conv.messages.push({ role: "user", text: "First question about " + title, images },
			{ role: "assistant", text: "An answer with maths \\(x^2\\).", status: "done", model: "m" });
		conv.restoring = false;
		old.lastChatIDs.set(conv.itemID, conv.chatID);
		await old.persistChat(conv);
	}
	let files = await IOUtils.getChildren(PathUtils.join(Zotero.DataDirectory.dir, "ai-chat"));
	check("the old build saved both chats", files.length === 2, files.map((f) => PathUtils.filename(f)).join(", "));

	let details = win.document.getElementById("zotero-item-details");
	await win.ZoteroPane.selectItem(a.id);
	await checkChat(details, old, "Paper A", "old build, library");
	let reader = await openReader(win, att.id);
	await checkChat(win.document.getElementById(reader.tabID + "-context"), old, "Paper A", "old build, PDF tab");
	win.Zotero_Tabs.select("zotero-pane");
	await sleep(500);

	// Install the new build over the running one, like Tools > Plugins > Install Plugin From File
	const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
	let install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(Zotero.Prefs.get("extensions.upgradetest.newXpi", true)));
	await install.install();
	let plugin = await waitFor(() => Zotero.AIChat && Zotero.AIChat !== old && Zotero.AIChat);
	check("the new build replaced it without a restart", plugin?.version === Zotero.Prefs.get("extensions.upgradetest.newVersion", true), plugin?.version);
	if (!plugin) return;
	await sleep(1500);
	await checkChat(details, plugin, "Paper A", "after the update, library (item still selected)");
	await win.ZoteroPane.selectItem(b.id);
	await checkChat(details, plugin, "Paper B", "after the update, library (another item)");
	await win.ZoteroPane.selectItem(a.id);
	await checkChat(details, plugin, "Paper A", "after the update, library (back again)");
	win.Zotero_Tabs.select(reader.tabID);
	await sleep(1000);
	await checkChat(win.document.getElementById(reader.tabID + "-context"), plugin, "Paper A",
		"after the update, the PDF tab that stayed open");
}

async function afterRestart(win) {
	await sleep(2500);
	let plugin = Zotero.AIChat;
	check("the new build runs after a restart", plugin?.version === Zotero.Prefs.get("extensions.upgradetest.newVersion", true), plugin?.version);
	if (!plugin) return;
	let items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
	let find = (title) => items.find((i) => i.isRegularItem() && i.getField("title") === title);
	let details = win.document.getElementById("zotero-item-details");
	await win.ZoteroPane.selectItem(find("Paper A").id);
	await checkChat(details, plugin, "Paper A", "after a restart, library");
	await win.ZoteroPane.selectItem(find("Paper B").id);
	await checkChat(details, plugin, "Paper B", "after a restart, library (another item)");
	let tab = win.Zotero_Tabs._tabs.find((t) => t.type === "reader" || t.type === "reader-unloaded");
	check("the PDF tab is restored", !!tab);
	if (!tab) return;
	win.Zotero_Tabs.select(tab.id);
	await waitFor(() => win.Zotero_Tabs.selectedType === "reader");
	if (win.ZoteroContextPane.collapsed) win.ZoteroContextPane.togglePane();
	let ctx = await waitFor(() => win.document.getElementById(win.Zotero_Tabs.selectedID + "-context"));
	await checkChat(ctx, plugin, "Paper A", "after a restart, the restored PDF tab");
}

async function run() {
	await Zotero.uiReadyPromise;
	let win = await waitFor(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView && Zotero.getMainWindow());
	win.resizeTo(1400, 900);
	await sleep(1500);
	if (Zotero.Prefs.get("extensions.upgradetest.phase", true) === 2) await afterRestart(win);
	else await beforeAndDuringUpdate(win);
	let errors = Zotero.getErrors(false).map((e) => String(e.message || e)).filter((m) => /aichat|AI Chat|zotero-ai-chat/i.test(m));
	check("no plugin errors in Zotero's error console", !errors.length, errors.join("\n"));
}

function startup() {
	run().catch((e) => check("test crashed", false, e && e.stack || e)).finally(async () => {
		await IOUtils.writeUTF8(Zotero.Prefs.get("extensions.upgradetest.out", true), JSON.stringify(results, null, 1));
		Services.startup.quit(Services.startup.eForceQuit);
	});
}
function shutdown() {}
function install() {}
function uninstall() {}
