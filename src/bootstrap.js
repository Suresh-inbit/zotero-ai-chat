/* global Services, AIChat */
var AIChat;

function install() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + "content/aichat.js");
	AIChat.init({ id, version, rootURI });
	await AIChat.startup();
}

function onMainWindowLoad({ window }) {
	AIChat?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	AIChat?.removeFromWindow(window);
}

function shutdown() {
	AIChat?.shutdown();
	AIChat = undefined;
}

function uninstall() {}
