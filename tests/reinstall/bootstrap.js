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
	out.oldVersionLoaded = !!Zotero.AIChat && typeof Zotero.AIChat.prepareImage !== "function";
	let item = new Zotero.Item("journalArticle"); item.setField("title", "Repro"); await item.saveTx();
	await win.ZoteroPane.selectItem(item.id);
	await sleep(1000);
	// Install the new build over the running old one, like Tools > Plugins > Install Plugin From File
	const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
	let install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(Zotero.Prefs.get("extensions.reinstalltest.newXpi", true)));
	await install.install();
	let plugin = await waitFor(() => Zotero.AIChat && typeof Zotero.AIChat.prepareImage === "function" && Zotero.AIChat);
	out.newVersionLoaded = true;
	await sleep(1000);
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
	let answer = await waitFor(() => root.querySelector(".aichat-answer"));
	out.formulas = answer.querySelectorAll(".katex").length;
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
