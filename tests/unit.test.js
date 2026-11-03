// Unit tests for the parts of the plugin that don't need a running Zotero:
// SSE parsing, both API clients, retry logic, the chat flow and the Markdown renderer.
//
// Run:  cd tests && npm install && npm test
"use strict";

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(path.join(__dirname, "../src/content/aichat.js"), "utf8");
const KATEX_SOURCE = fs.readFileSync(path.join(__dirname, "../src/content/katex/katex.min.js"), "utf8");

// Objects created inside the vm context have that context's prototypes, which strict
// deep-equality treats as different; compare plain copies instead
const plain = (value) => JSON.parse(JSON.stringify(value));

// Stand-in for Gecko's IOUtils, keeping files in memory. `delay` slows writes down so
// tests can check that writes to one file never overlap.
function memoryFS() {
	const fs = {
		files: new Map(),
		delay: 0,
		writes: 0,
		inFlight: 0,
		maxInFlight: 0,
		async exists(p) {
			return fs.files.has(p) || [...fs.files.keys()].some((k) => k.startsWith(p + "/"));
		},
		async readJSON(p) {
			if (!fs.files.has(p)) throw new Error("NotFoundError: " + p);
			return JSON.parse(fs.files.get(p));
		},
		async writeJSON(p, value) {
			fs.inFlight++;
			fs.maxInFlight = Math.max(fs.maxInFlight, fs.inFlight);
			await new Promise((r) => setTimeout(r, fs.delay));
			fs.files.set(p, JSON.stringify(value));
			fs.writes++;
			fs.inFlight--;
		},
		async makeDirectory() {},
		async remove(p, options = {}) {
			for (const k of [...fs.files.keys()]) {
				if (k === p || (options.recursive && k.startsWith(p + "/"))) fs.files.delete(k);
			}
		},
		async move(from, to) {
			fs.files.set(to, fs.files.get(from));
			fs.files.delete(from);
		}
	};
	return fs;
}

const HISTORY_FILE = "/data/ai-chat/1_ABCD2345.json";

function loadPlugin(prefs = {}, fs = memoryFS()) {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const logs = [];
	const Zotero = {
		DataDirectory: { dir: "/data" },
		Prefs: {
			get: (key) => prefs[key.replace("extensions.zotero-ai-chat.", "")],
			set: (key, value) => {
				prefs[key.replace("extensions.zotero-ai-chat.", "")] = value;
			}
		},
		debug: (msg) => logs.push(String(msg)),
		logError: (e) => logs.push(String(e)),
		launchURL: (url) => logs.push("launch:" + url),
		Utilities: { unescapeHTML: (s) => s.replace(/<[^>]+>/g, ""), Internal: {} }
	};
	const context = {
		Zotero,
		IOUtils: fs,
		PathUtils: { join: (...parts) => parts.join("/") },
		Services: {
			scriptloader: {
				// Stand-in for loading the bundled KaTeX, the only script the plugin loads itself
				loadSubScript(url, scope) {
					assert.match(url, /content\/katex\/katex\.min\.js$/);
					vm.runInNewContext(KATEX_SOURCE, scope, { filename: "katex.min.js" });
				}
			}
		},
		DOMParser: dom.window.DOMParser,
		TextDecoder,
		setTimeout,
		clearTimeout,
		console
	};
	vm.createContext(context);
	vm.runInContext(SOURCE, context, { filename: "aichat.js" });
	return { AIChat: context.AIChat, MD: context.AIChatMarkdown, MathX: context.AIChatMath, dom, logs, prefs, Zotero, fs };
}

const encoder = new TextEncoder();

// A streaming Response whose body arrives in tiny chunks, to exercise boundary handling
function streamResponse(text, { status = 200, chunkSize = 7, headers = {} } = {}) {
	const bytes = encoder.encode(text);
	let offset = 0;
	const body = new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + chunkSize));
			offset += chunkSize;
		}
	});
	return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

function jsonResponse(obj, status) {
	return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function anthropicSSE(texts, { stopReason = "end_turn", model = "claude-opus-5-5", withThinking = true } = {}) {
	let out = "";
	let ev = (type, data) => {
		out += `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
	};
	ev("message_start", { type: "message_start", message: { id: "msg_1", model, content: [] } });
	out += ": keep-alive comment\n\n";
	ev("ping", { type: "ping" });
	let index = 0;
	if (withThinking) {
		ev("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
		ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "SECRET-THOUGHTS" } });
		ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
		ev("content_block_stop", { type: "content_block_stop", index });
		index++;
	}
	ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
	for (let t of texts) {
		ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
	}
	ev("content_block_stop", { type: "content_block_stop", index });
	ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
	ev("message_stop", { type: "message_stop" });
	return out;
}

function openAISSE(texts, { finish = "stop", model = "gpt-test" } = {}) {
	let out = "";
	out += `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`;
	for (let t of texts) {
		out += `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: t } }] })}\n\n`;
	}
	out += `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`;
	out += "data: [DONE]\n\n";
	return out;
}

function fakeWin(handler) {
	const calls = [];
	return {
		calls,
		AbortController,
		fetch: async (url, opts) => {
			if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const call = { url, opts, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined };
			calls.push(call);
			return handler(call, calls.length);
		}
	};
}

const CONTEXT = { system: "SYSTEM PROMPT", document: "<document_text>PAPER TEXT</document_text>", summary: "paper.pdf" };

const tests = [];
function test(name, fn) {
	tests.push({ name, fn });
}

// ---------------------------------------------------------------------------

test("readSSE handles CRLF, comments, multi-line data and split chunks", async () => {
	const { AIChat } = loadPlugin();
	const text = "event: a\r\ndata: one\r\ndata: two\r\n\r\n: comment\n\nevent: b\ndata: {\"x\":\"é🙂\"}\n\n"
		+ "event: c\rdata: old-mac\r\rdata: last-no-newline";
	const expected = [["a", "one\ntwo"], ["b", "{\"x\":\"é🙂\"}"], ["c", "old-mac"], ["message", "last-no-newline"]];
	for (const chunkSize of [1, 2, 3, 5, 64, 1000]) {
		const events = [];
		await AIChat.readSSE(streamResponse(text, { chunkSize }), (name, data) => events.push([name, data]));
		assert.deepEqual(events, expected, `chunkSize ${chunkSize}`);
	}
	// Stream ending right after a lone \r
	const events = [];
	await AIChat.readSSE(streamResponse("data: x\r", { chunkSize: 1 }), (name, data) => events.push([name, data]));
	assert.deepEqual(events, [["message", "x"]]);
});

test("URL helpers accept base URLs with or without the API path", () => {
	const { AIChat } = loadPlugin();
	assert.equal(AIChat.anthropicURL("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
	assert.equal(AIChat.anthropicURL("https://proxy.example/v1"), "https://proxy.example/v1/messages");
	assert.equal(AIChat.anthropicURL("https://proxy.example/v1/messages"), "https://proxy.example/v1/messages");
	assert.equal(AIChat.openAIURL("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
	assert.equal(AIChat.openAIURL("https://router.requesty.ai/v1/chat/completions"), "https://router.requesty.ai/v1/chat/completions");
});

test("getSettings trims values and strips trailing slashes", () => {
	const { AIChat } = loadPlugin({
		provider: "openai",
		"openai.apiKey": "  key  ",
		"openai.model": " m ",
		"openai.baseURL": "http://localhost:11434/v1/"
	});
	const s = AIChat.getSettings();
	assert.equal(s.provider, "openai");
	assert.equal(s.apiKey, "key");
	assert.equal(s.model, "m");
	assert.equal(s.baseURL, "http://localhost:11434/v1");
	assert.equal(s.effort, "");
});

test("checkSettings reports what is missing", () => {
	const { AIChat } = loadPlugin();
	const ok = { provider: "anthropic", apiKey: "k", model: "claude-opus-5-5", baseURL: "https://api.anthropic.com" };
	assert.equal(AIChat.checkSettings(ok), null);
	assert.match(AIChat.checkSettings({ ...ok, apiKey: "" }), /API key/);
	assert.match(AIChat.checkSettings({ ...ok, model: "" }), /model/);
	assert.match(AIChat.checkSettings({ ...ok, baseURL: "" }), /base URL/);
	assert.match(AIChat.checkSettings({ ...ok, baseURL: "ftp://x" }), /http/);
	// OpenAI-compatible servers (e.g. Ollama) may not need a key
	assert.equal(AIChat.checkSettings({ ...ok, provider: "openai", apiKey: "" }), null);
});

test("Anthropic request shape, streaming text, ignoring thinking blocks", async () => {
	const { AIChat } = loadPlugin();
	const win = fakeWin(() => streamResponse(anthropicSSE(["Hello ", "wörld 🙂"])));
	const settings = { provider: "anthropic", apiKey: "sk-test", model: "claude-opus-5-5", baseURL: "https://proxy.example", effort: "medium" };
	let text = "";
	const result = await AIChat.streamAnthropic(settings, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, (t) => text += t);
	assert.equal(text, "Hello wörld 🙂");
	assert.equal(result.stopReason, "end_turn");
	assert.equal(result.model, "claude-opus-5-5");

	const call = win.calls[0];
	assert.equal(call.url, "https://proxy.example/v1/messages");
	assert.equal(call.opts.method, "POST");
	assert.equal(call.headers["x-api-key"], "sk-test");
	assert.equal(call.headers["anthropic-version"], "2026-10-21");
	assert.equal(call.headers["content-type"], "application/json");
	assert.equal(call.headers["anthropic-beta"], undefined, "no fallback beta for a non-Claude-API URL");
	assert.equal(call.body.model, "claude-opus-5-5");
	assert.equal(call.body.max_tokens, 64000);
	assert.equal(call.body.stream, true);
	assert.deepEqual(call.body.output_config, { effort: "medium" });
	assert.equal(call.body.fallbacks, undefined);
	assert.equal(call.body.temperature, undefined);
	assert.equal(call.body.thinking, undefined);
	assert.deepEqual(call.body.system, [
		{ type: "text", text: "SYSTEM PROMPT" },
		{ type: "text", text: CONTEXT.document, cache_control: { type: "ephemeral" } }
	]);
	assert.deepEqual(call.body.messages, [{ role: "user", content: "Q" }]);
});

test("Anthropic: server-side fallback is sent only to the Claude API for supported models", async () => {
	const { AIChat } = loadPlugin();
	const base = { provider: "anthropic", apiKey: "k", baseURL: "https://api.anthropic.com", effort: "low" };

	let win = fakeWin(() => streamResponse(anthropicSSE(["ok"])));
	await AIChat.streamAnthropic({ ...base, model: "claude-opus-5-5" }, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, () => {});
	assert.equal(win.calls[0].body.fallbacks, "default");
	assert.equal(win.calls[0].headers["anthropic-beta"], "server-side-fallback-2026-07-01");

	win = fakeWin(() => streamResponse(anthropicSSE(["ok"])));
	await AIChat.streamAnthropic({ ...base, model: "claude-haiku-5-5" }, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, () => {});
	assert.equal(win.calls[0].body.fallbacks, undefined, "Haiku has no server-side fallback");
	assert.equal(win.calls[0].headers["anthropic-beta"], undefined);
	assert.deepEqual(win.calls[0].body.output_config, { effort: "low" });

	win = fakeWin(() => streamResponse(anthropicSSE(["ok"])));
	await AIChat.streamAnthropic({ ...base, model: "claude-haiku-4-5" }, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, () => {});
	assert.equal(win.calls[0].body.output_config, undefined, "effort is not sent to models that reject it");
});

test("Anthropic: retries without an optional feature the server rejects", async () => {
	const { AIChat } = loadPlugin();
	const settings = { provider: "anthropic", apiKey: "k", model: "claude-opus-5-5", baseURL: "https://api.anthropic.com", effort: "high" };
	const win = fakeWin((call, n) => {
		if (n === 1) return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "fallbacks: Extra inputs are not permitted" } }, 400);
		if (n === 2) return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "output_config.effort: not supported" } }, 400);
		return streamResponse(anthropicSSE(["fine"]));
	});
	let text = "";
	await AIChat.streamAnthropic(settings, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, (t) => text += t);
	assert.equal(text, "fine");
	assert.equal(win.calls.length, 3);
	assert.equal(win.calls[1].body.fallbacks, undefined);
	assert.equal(win.calls[1].headers["anthropic-beta"], undefined);
	assert.deepEqual(win.calls[1].body.output_config, { effort: "high" });
	assert.equal(win.calls[2].body.output_config, undefined);
});

test("Anthropic: HTTP and in-stream errors become readable messages", async () => {
	const { AIChat } = loadPlugin();
	const settings = { provider: "anthropic", apiKey: "bad", model: "claude-opus-5-5", baseURL: "https://api.anthropic.com", effort: "" };
	let win = fakeWin(() => jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
	await assert.rejects(
		AIChat.streamAnthropic(settings, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, () => {}),
		(e) => /API error 401: invalid x-api-key\. Check your API key/.test(e.message)
	);
	assert.equal(win.calls.length, 1, "auth errors are not retried");

	win = fakeWin(() => streamResponse(
		`event: message_start\ndata: {"type":"message_start","message":{"model":"m"}}\n\n`
		+ `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`));
	await assert.rejects(
		AIChat.streamAnthropic(settings, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, () => {}),
		/API error: Overloaded/
	);

	win = fakeWin(() => new Response("<html>Bad gateway</html>", { status: 502 }));
	await assert.rejects(
		AIChat.streamAnthropic(settings, CONTEXT, [{ role: "user", content: "Q" }], undefined, win, () => {}),
		/API error 502: <html>Bad gateway<\/html>/
	);
});

test("OpenAI-compatible request shape and streaming", async () => {
	const { AIChat } = loadPlugin();
	let win = fakeWin(() => streamResponse(openAISSE(["Hi ", "there"], { finish: "length", model: "openai/gpt-x" })));
	const settings = { provider: "openai", apiKey: "sk-o", model: "openai/gpt-x", baseURL: "https://router.requesty.ai/v1", effort: "" };
	let text = "";
	const history = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
	const result = await AIChat.streamOpenAI(settings, CONTEXT, history, undefined, win, (t) => text += t);
	assert.equal(text, "Hi there");
	assert.equal(result.stopReason, "length");
	assert.equal(result.model, "openai/gpt-x");
	const call = win.calls[0];
	assert.equal(call.url, "https://router.requesty.ai/v1/chat/completions");
	assert.equal(call.headers.authorization, "Bearer sk-o");
	assert.equal(call.body.stream, true);
	assert.equal(call.body.model, "openai/gpt-x");
	assert.equal(call.body.max_tokens, undefined);
	assert.equal(call.body.temperature, undefined);
	assert.deepEqual(call.body.messages[0], { role: "system", content: "SYSTEM PROMPT\n\n" + CONTEXT.document });
	assert.deepEqual(call.body.messages.slice(1), history);

	// No key: no Authorization header (local servers)
	win = fakeWin(() => streamResponse(openAISSE(["x"])));
	await AIChat.streamOpenAI({ ...settings, apiKey: "" }, CONTEXT, history, undefined, win, () => {});
	assert.equal(win.calls[0].headers.authorization, undefined);

	// Errors
	win = fakeWin(() => jsonResponse({ error: { message: "model not found" } }, 404));
	await assert.rejects(AIChat.streamOpenAI(settings, CONTEXT, history, undefined, win, () => {}),
		/API error 404: model not found\. Check the base URL and model name/);
	win = fakeWin(() => streamResponse(`data: {"error":{"message":"quota exceeded"}}\n\n`));
	await assert.rejects(AIChat.streamOpenAI(settings, CONTEXT, history, undefined, win, () => {}), /quota exceeded/);
	win = fakeWin(() => streamResponse(openAISSE(["partial"], { finish: "content_filter" })));
	const filtered = await AIChat.streamOpenAI(settings, CONTEXT, history, undefined, win, () => {});
	assert.equal(filtered.stopReason, "refusal");
});

test("favorite models: split on lines or commas, trimmed, de-duplicated", () => {
	const { AIChat } = loadPlugin({ "favoriteModels.anthropic": " a \nb,a,,  c\n\n" });
	assert.deepEqual(plain(AIChat.getFavoriteModels("anthropic")), ["a", "b", "c"]);
	assert.deepEqual(plain(AIChat.getFavoriteModels("openai")), []);
});

test("setModel writes the provider's model pref", () => {
	const { AIChat, prefs } = loadPlugin({ "anthropic.model": "old" });
	AIChat.setModel("anthropic", "claude-haiku-5-5");
	assert.equal(prefs["anthropic.model"], "claude-haiku-5-5");
});

test("modelsURL for each provider and base URL shape", () => {
	const { AIChat } = loadPlugin();
	assert.equal(AIChat.modelsURL("anthropic", "https://api.anthropic.com"), "https://api.anthropic.com/v1/models?limit=1000");
	assert.equal(AIChat.modelsURL("anthropic", "https://proxy.example/v1/messages"), "https://proxy.example/v1/models?limit=1000");
	assert.equal(AIChat.modelsURL("openai", "https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/models");
	assert.equal(AIChat.modelsURL("openai", "http://localhost:11434/v1/chat/completions"), "http://localhost:11434/v1/models");
});

test("listModels: parses both providers, sends the right headers, reports errors", async () => {
	const env = loadPlugin({
		provider: "anthropic",
		"anthropic.apiKey": "k",
		"anthropic.baseURL": "https://api.anthropic.com",
		"openai.baseURL": "http://localhost:11434/v1"
	});
	const { AIChat, Zotero } = env;

	let win = fakeWin(() => jsonResponse({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }, {}] }, 200));
	Zotero.getMainWindow = () => win;
	assert.deepEqual(plain(await AIChat.listModels("anthropic")), ["a-model", "z-model"]);
	assert.equal(win.calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
	assert.equal(win.calls[0].headers["x-api-key"], "k");
	assert.equal(win.calls[0].headers["anthropic-version"], "2026-10-21");

	win = fakeWin(() => jsonResponse({ data: [{ id: "llama3.1" }] }, 200));
	Zotero.getMainWindow = () => win;
	assert.deepEqual(plain(await AIChat.listModels("openai")), ["llama3.1"]);
	assert.equal(win.calls[0].url, "http://localhost:11434/v1/models");
	assert.equal(win.calls[0].headers.authorization, undefined, "no key, no Authorization header");

	win = fakeWin(() => jsonResponse({ error: { message: "invalid x-api-key" } }, 401));
	Zotero.getMainWindow = () => win;
	await assert.rejects(AIChat.listModels("anthropic"), /API error 401: invalid x-api-key/);

	win = fakeWin(() => jsonResponse({ data: [] }, 200));
	Zotero.getMainWindow = () => win;
	await assert.rejects(AIChat.listModels("openai"), /no models/);

	const noKey = loadPlugin({ provider: "anthropic", "anthropic.baseURL": "https://api.anthropic.com" });
	noKey.Zotero.getMainWindow = () => fakeWin(() => {
		throw new Error("should not be called");
	});
	await assert.rejects(noKey.AIChat.listModels("anthropic"), /Paste your Claude API key/);
});

test("presets: OpenRouter and Requesty read their own settings; unknown providers fall back to Claude", () => {
	const rq = loadPlugin({
		provider: "requesty",
		"requesty.apiKey": "rk",
		"requesty.baseURL": "https://router.requesty.ai/v1/",
		"requesty.model": "openai/gpt-4o"
	}).AIChat.getSettings();
	assert.equal(rq.provider, "requesty");
	assert.equal(rq.apiKey, "rk");
	assert.equal(rq.baseURL, "https://router.requesty.ai/v1");
	assert.equal(rq.model, "openai/gpt-4o");

	const or = loadPlugin({ provider: "openrouter", "openrouter.apiKey": "ok" }).AIChat;
	assert.equal(or.getSettings().provider, "openrouter");
	assert.equal(or.getSettings("anthropic").provider, "anthropic", "an explicit provider argument wins");

	assert.equal(loadPlugin({ provider: "bogus" }).AIChat.getSettings().provider, "anthropic");
});

test("presets: hosted services require a key before any request", () => {
	const { AIChat } = loadPlugin();
	const base = { model: "m", baseURL: "https://openrouter.ai/api/v1" };
	assert.match(AIChat.checkSettings({ ...base, provider: "openrouter", apiKey: "" }), /No OpenRouter API key/);
	assert.match(AIChat.checkSettings({ ...base, provider: "requesty", apiKey: "" }), /No Requesty API key/);
	assert.equal(AIChat.checkSettings({ ...base, provider: "requesty", apiKey: "k" }), null);
	// Local OpenAI-compatible servers may run without a key
	assert.equal(AIChat.checkSettings({ ...base, provider: "openai", apiKey: "" }), null);
});

// ---------------------------------------------------------------------------
// Conversation flow (send) with a fake item and window

function setupSend(prefs, handler, fs) {
	const env = loadPlugin({
		provider: "anthropic",
		"anthropic.apiKey": "k",
		"anthropic.model": "claude-opus-5-5",
		"anthropic.baseURL": "https://proxy.example",
		"anthropic.effort": "medium",
		...prefs
	}, fs);
	let contextBuilds = 0;
	env.AIChat.buildContext = async () => {
		contextBuilds++;
		return CONTEXT;
	};
	const win = fakeWin(handler);
	const item = { id: 42, libraryID: 1, key: "ABCD2345" };
	const conv = env.AIChat.getConversation(item);
	return { ...env, win, item, conv, contextBuilds: () => contextBuilds };
}

test("send: builds context once, keeps history of good answers only", async () => {
	let n = 0;
	const env = setupSend({}, (call) => {
		n++;
		if (n === 2) return jsonResponse({ error: { message: "server exploded" } }, 500);
		return streamResponse(anthropicSSE([`answer ${n}`]));
	});
	const { AIChat, conv, item, win } = env;

	await AIChat.send(conv, item, win, "  first question  ");
	assert.equal(conv.messages.length, 2);
	assert.equal(conv.messages[0].text, "first question");
	assert.equal(conv.messages[1].status, "done");
	assert.equal(conv.messages[1].text, "answer 1");
	assert.equal(conv.busy, false);

	await AIChat.send(conv, item, win, "second");
	assert.equal(conv.messages[3].status, "error");
	assert.match(conv.messages[3].error, /API error 500: server exploded/);

	await AIChat.send(conv, item, win, "third");
	assert.equal(conv.messages[5].text, "answer 3");
	assert.equal(env.contextBuilds(), 1);
	// The failed turn is not sent back to the model
	assert.deepEqual(win.calls[2].body.messages, [
		{ role: "user", content: "first question" },
		{ role: "assistant", content: "answer 1" },
		{ role: "user", content: "third" }
	]);
	// The cached system prompt is identical on every request
	assert.deepEqual(win.calls[0].body.system, win.calls[2].body.system);
});

test("send: refusals discard partial text; empty answers are errors; cut-off answers get a notice", async () => {
	let mode = "refusal";
	const env = setupSend({}, () => {
		if (mode === "refusal") return streamResponse(anthropicSSE(["partial words"], { stopReason: "refusal" }));
		if (mode === "empty") return streamResponse(anthropicSSE([], { stopReason: "end_turn" }));
		return streamResponse(anthropicSSE(["long answer"], { stopReason: "max_tokens" }));
	});
	const { AIChat, conv, item, win } = env;
	await AIChat.send(conv, item, win, "q1");
	assert.equal(conv.messages[1].status, "refused");
	assert.equal(conv.messages[1].text, "");
	assert.match(conv.messages[1].error, /declined/);

	mode = "empty";
	await AIChat.send(conv, item, win, "q2");
	assert.equal(conv.messages[3].status, "error");
	assert.match(conv.messages[3].error, /empty response/);

	mode = "cut";
	await AIChat.send(conv, item, win, "q3");
	assert.equal(conv.messages[5].status, "done");
	assert.match(conv.messages[5].notice, /cut off/);
	assert.deepEqual(plain(AIChat.buildHistory(conv)), [
		{ role: "user", content: "q3" },
		{ role: "assistant", content: "long answer" }
	]);
});

test("send: missing settings show an error without calling the API", async () => {
	const env = setupSend({ "anthropic.apiKey": "" }, () => {
		throw new Error("should not be called");
	});
	await env.AIChat.send(env.conv, env.item, env.win, "hello");
	assert.equal(env.conv.messages[1].status, "error");
	assert.equal(env.conv.messages[1].needsSettings, true);
	assert.equal(env.win.calls.length, 0);
	assert.equal(env.conv.busy, false);
});

test("send: Stop aborts the stream and keeps the partial answer", async () => {
	let release;
	const env = setupSend({}, (call) => {
		const signal = call.opts.signal;
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(
					`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n`));
				release = () => {};
				signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
			}
		});
		return new Response(body, { status: 200 });
	});
	const { AIChat, conv, item, win } = env;
	const done = AIChat.send(conv, item, win, "long one");
	for (let i = 0; i < 50 && !conv.messages[1]?.text; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(conv.busy, true);
	conv.abort.abort();
	await done;
	assert.equal(conv.messages[1].status, "stopped");
	assert.equal(conv.messages[1].text, "partial");
	assert.equal(conv.busy, false);
	assert.ok(release);
});

test("clearConversation while streaming leaves the new chat usable", async () => {
	const env = setupSend({}, (call) => {
		const signal = call.opts.signal;
		const body = new ReadableStream({
			start(controller) {
				signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
			}
		});
		return new Response(body, { status: 200 });
	});
	const { AIChat, conv, item, win } = env;
	const pending = AIChat.send(conv, item, win, "q");
	await new Promise((r) => setTimeout(r, 20));
	AIChat.clearConversation(conv);
	assert.equal(conv.busy, false);
	assert.equal(conv.messages.length, 0);
	await pending;
	assert.equal(conv.busy, false);
	assert.equal(conv.messages.length, 0);
});

const IMG = { id: "1", mediaType: "image/png", data: "AAAA", dataURL: "data:image/png;base64,AAAA" };
const IMG2 = { id: "2", mediaType: "image/jpeg", data: "BBBB", dataURL: "data:image/jpeg;base64,BBBB" };

test("images: message conversion for Claude and OpenAI-compatible APIs", () => {
	const { AIChat } = loadPlugin();
	const messages = [
		{ role: "user", content: "see", images: [IMG, IMG2] },
		{ role: "assistant", content: "ok" },
		{ role: "user", content: "", images: [IMG] },
		{ role: "user", content: "text only" }
	];
	assert.deepEqual(plain(AIChat.toAnthropicMessages(messages)), [
		{ role: "user", content: [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
			{ type: "text", text: "see" }] },
		{ role: "assistant", content: "ok" },
		{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
		{ role: "user", content: "text only" }
	]);
	assert.deepEqual(plain(AIChat.toOpenAIMessages(messages)), [
		{ role: "user", content: [
			{ type: "text", text: "see" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }] },
		{ role: "assistant", content: "ok" },
		{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
		{ role: "user", content: "text only" }
	]);
});

test("images: sent with the question, kept in history, restored to the tray when the request fails", async () => {
	let n = 0;
	const env = setupSend({}, () => {
		n++;
		if (n === 3) return jsonResponse({ error: { message: "this model does not support images" } }, 400);
		return streamResponse(anthropicSSE(["ok"]));
	});
	const { AIChat, conv, item, win } = env;

	await AIChat.send(conv, item, win, "What is this?", [IMG]);
	assert.deepEqual(win.calls[0].body.messages, [{ role: "user", content: [
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		{ type: "text", text: "What is this?" }] }]);
	assert.equal(win.calls[0].opts.body.includes("dataURL"), false, "internal fields are not sent");

	// An image-only question is allowed; the earlier image stays in the history
	await AIChat.send(conv, item, win, "", [IMG2]);
	const second = win.calls[1].body.messages;
	assert.equal(second.length, 3);
	assert.ok(Array.isArray(second[0].content) && second[0].content[0].type === "image");
	assert.deepEqual(second[2].content, [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }]);

	// Nothing to send: ignored
	await AIChat.send(conv, item, win, "   ", []);
	assert.equal(win.calls.length, 2);

	// Failure puts the images back so the user doesn't have to crop again
	await AIChat.send(conv, item, win, "again", [IMG]);
	assert.equal(conv.messages[conv.messages.length - 1].status, "error");
	assert.deepEqual(plain(conv.pendingImages.map((i) => i.id)), ["1"]);
});

test("images: missing settings also restore the images", async () => {
	const env = setupSend({ "anthropic.apiKey": "" }, () => {
		throw new Error("should not be called");
	});
	await env.AIChat.send(env.conv, env.item, env.win, "q", [IMG]);
	assert.deepEqual(plain(env.conv.pendingImages.map((i) => i.id)), ["1"]);
	assert.equal(env.win.calls.length, 0);
});

test("images: new chat clears pending images", () => {
	const env = setupSend({}, () => null);
	env.conv.pendingImages = [IMG];
	env.AIChat.clearConversation(env.conv);
	assert.equal(env.conv.pendingImages.length, 0);
});

test("retry: asks a failed question again with its images", async () => {
	let n = 0;
	const env = setupSend({}, () => {
		n++;
		if (n === 1) return jsonResponse({ error: { message: "overloaded" } }, 529);
		return streamResponse(anthropicSSE(["fine now"]));
	});
	const { AIChat, conv, item, win } = env;
	await AIChat.send(conv, item, win, "look", [IMG]);
	assert.equal(conv.messages[1].status, "error");
	assert.equal(conv.pendingImages.length, 1, "images went back to the tray");
	await AIChat.retry(conv, item, win, 1);
	assert.equal(conv.messages.length, 2);
	assert.equal(conv.messages[1].text, "fine now");
	assert.equal(conv.pendingImages.length, 0, "the retry took the images with it");
	assert.equal(win.calls[1].body.messages[0].content[0].type, "image");
	// Only failed answers can be retried
	await AIChat.retry(conv, item, win, 1);
	assert.equal(win.calls.length, 2);
});

// ---------------------------------------------------------------------------
// Chat history

const okAnswers = () => {
	let n = 0;
	return () => streamResponse(anthropicSSE([`answer ${++n}`]));
};
const savedChats = (fs) => JSON.parse(fs.files.get(HISTORY_FILE)).chats;
const settle = (AIChat) => Promise.all([...AIChat.historyQueue.values()]);

test("history: each answer is saved; failed turns and internal image fields are not", async () => {
	let n = 0;
	const env = setupSend({}, () => {
		n++;
		if (n === 2) return jsonResponse({ error: { message: "boom" } }, 500);
		return streamResponse(anthropicSSE([`answer ${n}`]));
	});
	const { AIChat, conv, item, win, fs } = env;
	await AIChat.send(conv, item, win, "first question", [{ ...IMG, width: 10, height: 20 }]);
	let chats = savedChats(fs);
	assert.equal(chats.length, 1);
	assert.equal(chats[0].id, conv.chatID);
	assert.equal(chats[0].title, "first question");
	assert.deepEqual(chats[0].messages, [
		{ role: "user", text: "first question", images: [{ mediaType: "image/png", data: "AAAA", width: 10, height: 20 }] },
		{ role: "assistant", text: "answer 1", status: "done", model: "claude-opus-5-5", notice: "" }
	]);
	const writes = fs.writes;
	await AIChat.send(conv, item, win, "second");
	assert.equal(fs.writes, writes, "a failed turn doesn't rewrite the file");
	await AIChat.send(conv, item, win, "third");
	// An answer that breaks off with an error mid-stream has text, but is still a failure
	win.calls.length = 0;
	const errorMidStream = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half"}}\n\n`
		+ `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;
	const handler = win.fetch;
	win.fetch = async () => streamResponse(errorMidStream);
	await AIChat.send(conv, item, win, "fourth");
	win.fetch = handler;
	assert.equal(conv.messages[7].status, "error");
	assert.equal(conv.messages[7].text, "half");
	chats = savedChats(fs);
	assert.equal(chats.length, 1);
	assert.deepEqual(chats[0].messages.filter((m) => m.role === "user").map((m) => m.text), ["first question", "third"]);
	assert.ok(!fs.files.get(HISTORY_FILE).includes("dataURL"));
	assert.deepEqual(JSON.parse(fs.files.get(HISTORY_FILE)).key, "ABCD2345");
});

test("history: New chat keeps the old one; the list is newest first; an old chat can be continued", async () => {
	const env = setupSend({}, okAnswers());
	const { AIChat, conv, item, win } = env;
	await AIChat.send(conv, item, win, "chat one", [IMG]);
	const firstID = conv.chatID;
	AIChat.clearConversation(conv);
	assert.notEqual(conv.chatID, firstID);
	assert.equal(conv.messages.length, 0);
	await AIChat.send(conv, item, win, "chat two");
	let list = plain(await AIChat.listChats(conv));
	assert.deepEqual(list.map((c) => [c.title, c.count]), [["chat two", 1], ["chat one", 1]]);

	assert.equal(await AIChat.openChat(conv, firstID), true);
	assert.equal(conv.chatID, firstID);
	assert.equal(conv.messages[0].text, "chat one");
	assert.equal(conv.messages[0].images[0].dataURL, "data:image/png;base64,AAAA", "thumbnail restored");
	assert.equal(conv.context, null, "the item is read again for the next question");
	await AIChat.send(conv, item, win, "follow-up");
	const last = win.calls[win.calls.length - 1].body.messages;
	assert.equal(last.length, 3);
	assert.equal(last[0].content[1].text, "chat one");
	assert.equal(last[0].content[0].source.data, "AAAA", "earlier image still sent");
	assert.equal(last[1].content, "answer 1");
	list = plain(await AIChat.listChats(conv));
	assert.deepEqual(list.map((c) => [c.title, c.count]), [["chat one", 2], ["chat two", 1]]);
	// Re-opening the open chat is a no-op; unknown chats aren't opened
	assert.equal(await AIChat.openChat(conv, firstID), true);
	assert.equal(await AIChat.openChat(conv, "nope"), false);
	assert.equal(conv.chatID, firstID);
});

test("history: a new session reopens the latest chat; in a session, New chat is respected", async () => {
	const env = setupSend({}, okAnswers());
	await env.AIChat.send(env.conv, env.item, env.win, "remember me");

	// Zotero restarted: a new plugin instance with the same data directory
	const env2 = setupSend({}, okAnswers(), env.fs);
	assert.equal(env2.conv.messages.length, 0);
	await env2.AIChat.restoreChat(env2.conv);
	assert.equal(env2.conv.messages.length, 2);
	assert.equal(env2.conv.messages[0].text, "remember me");
	assert.equal(env2.conv.restoring, false);
	assert.equal(env2.AIChat.canForget(env2.conv), true, "fully saved, so it can be dropped and reloaded");

	// New chat, then the user goes to another item and back: the empty new chat stays
	env2.AIChat.clearConversation(env2.conv);
	env2.AIChat.conversations.delete(env2.item.id);
	const again = env2.AIChat.getConversation(env2.item);
	await env2.AIChat.restoreChat(again);
	assert.equal(again.messages.length, 0);

	// A restore that finishes after the user started a new chat doesn't replace it
	const env3 = setupSend({}, okAnswers(), env.fs);
	const pending = env3.AIChat.restoreChat(env3.conv);
	env3.AIChat.clearConversation(env3.conv);
	await pending;
	assert.equal(env3.conv.messages.length, 0);
	// Only checked once per conversation
	await env3.AIChat.restoreChat(env3.conv);
	assert.equal(env3.conv.messages.length, 0);
});

test("history: an answer interrupted by New chat is kept as stopped", async () => {
	const env = setupSend({}, (call) => {
		const signal = call.opts.signal;
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(
					`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half an answer"}}\n\n`));
				signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
			}
		});
		return new Response(body, { status: 200 });
	});
	const { AIChat, conv, item, win, fs } = env;
	const pending = AIChat.send(conv, item, win, "long one");
	for (let i = 0; i < 50 && !conv.messages[1]?.text; i++) await new Promise((r) => setTimeout(r, 10));
	AIChat.clearConversation(conv);
	await pending;
	await settle(AIChat);
	const chats = savedChats(fs);
	assert.equal(chats.length, 1);
	assert.equal(chats[0].messages[1].status, "stopped");
	assert.equal(chats[0].messages[1].text, "half an answer");
	assert.equal(conv.messages.length, 0);
});

test("history: deleting chats; deleting the open chat starts a new one", async () => {
	const env = setupSend({}, okAnswers());
	const { AIChat, conv, item, win, fs } = env;
	await AIChat.send(conv, item, win, "a");
	const idA = conv.chatID;
	AIChat.clearConversation(conv);
	await AIChat.send(conv, item, win, "b");
	const idB = conv.chatID;
	await AIChat.deleteChat(conv, idA);
	assert.deepEqual(plain((await AIChat.listChats(conv)).map((c) => c.title)), ["b"]);
	assert.equal(conv.chatID, idB, "deleting another chat leaves the open one alone");
	conv.draft = "typed";
	await AIChat.deleteChat(conv, idB);
	assert.notEqual(conv.chatID, idB);
	assert.equal(conv.messages.length, 0);
	assert.equal(conv.draft, "typed", "what's being typed is kept");
	assert.equal(fs.files.has(HISTORY_FILE), false, "an item with no chats has no file");
});

test("history: turned off, nothing is read or written", async () => {
	const fs = memoryFS();
	fs.files.set(HISTORY_FILE, JSON.stringify({ chats: [{ id: "x", created: 1, updated: 1, messages: [
		{ role: "user", text: "old" }, { role: "assistant", text: "old answer", status: "done" }] }] }));
	const env = setupSend({ saveHistory: false }, okAnswers(), fs);
	const { AIChat, conv, item, win } = env;
	await AIChat.restoreChat(conv);
	assert.equal(conv.messages.length, 0);
	await AIChat.send(conv, item, win, "private");
	assert.equal(fs.writes, 0);
	assert.deepEqual(plain(await AIChat.listChats(conv)), []);
	assert.equal(AIChat.canForget(conv), false, "an unsaved chat must stay in memory");
});

test("history: an unreadable or odd file is handled safely", async () => {
	const fs = memoryFS();
	fs.files.set(HISTORY_FILE, "{not json");
	const env = setupSend({}, okAnswers(), fs);
	const { AIChat, conv, item, win } = env;
	await AIChat.restoreChat(conv);
	assert.equal(conv.messages.length, 0);
	const aside = [...fs.files.keys()].find((k) => k.includes("unreadable"));
	assert.ok(aside, "the unreadable file is kept under another name");
	assert.equal(fs.files.get(aside), "{not json");
	await AIChat.send(conv, item, win, "fresh start");
	assert.equal(savedChats(fs).length, 1);

	// Malformed entries are skipped, valid ones survive, bad image types are dropped
	const fs2 = memoryFS();
	fs2.files.set(HISTORY_FILE, JSON.stringify({ chats: [
		null,
		{ id: "", messages: [] },
		{ id: "bad", messages: [{ role: "assistant", text: "x" }, { role: "user", text: "y" }] },
		{ id: "good", created: 5, updated: 9, messages: [
			{ role: "user", text: "q", images: [{ mediaType: "text/html", data: "PHNjcmlwdD4=" }, { mediaType: "image/jpeg", data: "QQ==" }] },
			{ role: "assistant", text: "a", status: "weird" }] }
	] }));
	const env2 = setupSend({}, okAnswers(), fs2);
	await env2.AIChat.restoreChat(env2.conv);
	assert.equal(env2.conv.chatID, "good");
	assert.equal(env2.conv.messages[0].images.length, 1);
	assert.equal(env2.conv.messages[0].images[0].mediaType, "image/jpeg");
	assert.equal(env2.conv.messages[1].status, "done");
});

test("history: writes to one file run one at a time and keep every chat", async () => {
	const fs = memoryFS();
	fs.delay = 15;
	const { AIChat } = loadPlugin({}, fs);
	const conv = AIChat.getConversation({ id: 7, libraryID: 1, key: "ABCD2345" });
	const pending = [];
	for (let i = 0; i < 4; i++) {
		conv.messages = [{ role: "user", text: `q${i}` }, { role: "assistant", text: "a", status: "done" }];
		pending.push(AIChat.persistChat(conv));
		AIChat.resetConversation(conv, { persist: false });
	}
	await Promise.all(pending);
	assert.equal(fs.maxInFlight, 1);
	assert.deepEqual(savedChats(fs).map((c) => c.title), ["q3", "q2", "q1", "q0"]);
	assert.equal(AIChat.historyQueue.size, 0, "finished writes are forgotten");
});

test("history: at most 50 chats per item; titles", async () => {
	const { AIChat, fs } = loadPlugin();
	const conv = AIChat.getConversation({ id: 7, libraryID: 1, key: "ABCD2345" });
	for (let i = 0; i < 52; i++) {
		conv.messages = [{ role: "user", text: `q${i}` }, { role: "assistant", text: "a", status: "done" }];
		await AIChat.persistChat(conv);
		AIChat.resetConversation(conv, { persist: false });
	}
	const chats = savedChats(fs);
	assert.equal(chats.length, 50);
	assert.equal(chats[0].title, "q51");
	assert.equal(chats[49].title, "q2");

	assert.equal(AIChat.chatTitle([]), "New chat");
	assert.equal(AIChat.chatTitle([{ role: "user", text: "", images: [IMG] }]), "Question about an image");
	const long = AIChat.chatTitle([{ role: "user", text: "word ".repeat(40) }]);
	assert.equal(long.length, 80);
	assert.ok(long.endsWith("…"));
	assert.equal(AIChat.chatTitle([{ role: "user", text: "  two\n\nlines " }]), "two lines");
});

test("history: items without a usable key are never written", async () => {
	const { AIChat, fs } = loadPlugin();
	for (const item of [{ id: 1, libraryID: 1, key: "../../etc" }, { id: 2, libraryID: "1", key: "ABCD2345" }, { id: 3 }]) {
		const conv = AIChat.getConversation(item);
		conv.messages = [{ role: "user", text: "q" }, { role: "assistant", text: "a", status: "done" }];
		await AIChat.persistChat(conv);
	}
	assert.equal(fs.files.size, 0);
});

test("history: deleting an item deletes its chats; Delete all chat history removes everything", async () => {
	const env = setupSend({}, okAnswers());
	const { AIChat, conv, item, win, fs } = env;
	await AIChat.send(conv, item, win, "about to go");
	assert.ok(fs.files.has(HISTORY_FILE));
	AIChat.onItemsDeleted([42], { 42: { libraryID: 1, key: "ABCD2345" } });
	await settle(AIChat);
	assert.equal(fs.files.has(HISTORY_FILE), false);
	assert.equal(AIChat.conversations.has(42), false);

	const other = AIChat.getConversation({ id: 43, libraryID: 1, key: "WXYZ6789" });
	await AIChat.send(other, { id: 43 }, win, "keep?");
	const conv2 = AIChat.getConversation(item);
	await AIChat.send(conv2, item, win, "and me");
	assert.equal(fs.files.size, 2);
	other.draft = "half-typed";
	await AIChat.clearAllHistory();
	assert.equal(fs.files.size, 0);
	assert.equal(other.messages.length, 0, "open chats are part of the history, so they're emptied");
	assert.equal(other.draft, "half-typed");
	assert.deepEqual(plain(await AIChat.listChats(other)), []);
});

test("history: canForget only drops conversations that can be reloaded", async () => {
	const env = setupSend({}, (call, n) => n === 2
		? jsonResponse({ error: { message: "nope" } }, 500)
		: streamResponse(anthropicSSE(["ok"])));
	const { AIChat, conv, item, win } = env;
	assert.equal(AIChat.canForget(conv), true, "empty");
	await AIChat.send(conv, item, win, "saved");
	assert.equal(AIChat.canForget(conv), true, "everything is in the file");
	conv.draft = "x";
	assert.equal(AIChat.canForget(conv), false, "something is being typed");
	conv.draft = "";
	await AIChat.send(conv, item, win, "fails");
	assert.equal(AIChat.canForget(conv), false, "the failed turn exists only in memory");
});

// ---------------------------------------------------------------------------
// Markdown

function md(src, options) {
	const { MD, dom } = loadPlugin();
	const div = dom.window.document.createElement("div");
	MD.render(dom.window.document, div, src, options);
	return div.innerHTML;
}

test("Markdown: blocks", () => {
	assert.equal(md("# Title\n\nPara one\nline two"), "<h3>Title</h3><p>Para one<br>line two</p>");
	assert.equal(md("## Sub ##"), "<h4>Sub</h4>");
	assert.equal(md("---"), "<hr>");
	assert.equal(md("```js\nlet a = 1 < 2;\n\n<b>x</b>\n```\nafter"),
		"<pre><code>let a = 1 &lt; 2;\n\n&lt;b&gt;x&lt;/b&gt;</code></pre><p>after</p>");
	assert.equal(md("```\nunclosed"), "<pre><code>unclosed</code></pre>");
	assert.equal(md("> quoted **bold**\n> more"), "<blockquote><p>quoted <strong>bold</strong><br>more</p></blockquote>");
});

test("Markdown: lists, nesting, ordered start", () => {
	assert.equal(md("- a\n- b\n  - b1\n  - b2\n- c"),
		"<ul><li>a</li><li>b<ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>");
	assert.equal(md("3. three\n4. four"), "<ol start=\"3\"><li>three</li><li>four</li></ol>");
	assert.equal(md("1. one\n\n2. two\n\nPara"), "<ol><li>one</li><li>two</li></ol><p>Para</p>");
	assert.equal(md("* item with\n  continuation"), "<ul><li>item with<br>continuation</li></ul>");
});

test("Markdown: tables", () => {
	assert.equal(md("| A | B |\n|---|:-:|\n| 1 | **2** |\n| x \\| y |"),
		"<div class=\"aichat-table-wrap\"><table><thead><tr><th>A</th><th>B</th></tr></thead>"
		+ "<tbody><tr><td>1</td><td><strong>2</strong></td></tr><tr><td>x | y</td><td></td></tr></tbody></table></div>");
	// A paragraph followed by a horizontal rule is not a table
	assert.equal(md("a | b\n---"), "<p>a | b</p><hr>");
});

test("Markdown: inline formatting", () => {
	assert.equal(md("**bold** and *it* and _it2_ and `co*de*`"),
		"<p><strong>bold</strong> and <em>it</em> and <em>it2</em> and <code>co*de*</code></p>");
	assert.equal(md("snake_case_name and 2 * 3 * 4"), "<p>snake_case_name and 2 * 3 * 4</p>");
	assert.equal(md("**bold with *nested* em**"), "<p><strong>bold with <em>nested</em> em</strong></p>");
});

test("Markdown: links are safe", () => {
	const html = md("[site](https://example.org/a_b) and https://doi.org/10.1/x. and [bad](javascript:alert(1))");
	assert.match(html, /<a class="aichat-link" title="https:\/\/example.org\/a_b" tabindex="0" role="link">site<\/a>/);
	assert.match(html, /<a class="aichat-link" title="https:\/\/doi.org\/10.1\/x" tabindex="0" role="link">https:\/\/doi.org\/10.1\/x<\/a>\./);
	assert.doesNotMatch(html, /javascript:/);
	assert.doesNotMatch(html, /href=/, "links in the chat have no href");
	const note = md("[site](https://example.org)", { forNote: true });
	assert.equal(note, "<p><a href=\"https://example.org\">site</a></p>");
});

test("Markdown: model output cannot inject HTML", () => {
	const html = md("<img src=x onerror=alert(1)> <script>bad()</script>\n\n| <b>h</b> |\n|---|\n| <i>c</i> |");
	assert.doesNotMatch(html, /<img|<script|<b>|<i>/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("Markdown: streaming partial input never throws", () => {
	const src = "# H\n\n- a\n  - b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\n**bold** [l](https://e.org)";
	for (let i = 0; i <= src.length; i++) md(src.slice(0, i));
});

// ---------------------------------------------------------------------------
// Maths

// The answer from the screenshot that showed raw LaTeX (abridged)
const SCREENSHOT_ANSWER = [
	"- \\(\\tilde C\\): render **after** the appearance adjustment.",
	"- The paper sets \\(\\lambda_{\\text{dssim}}=0.2\\).",
	"",
	"The uncertainty predictor is trained using a clipped distance (Eqs. 8–9, §3.3, pp. 5–6):",
	"",
	"\\[",
	"L_{\\text{DINO}}",
	"=\\min\\!\\left(1,\\;2-2\\cos(\\tilde D,D)\\right),",
	"\\qquad",
	"L_{\\text{uncertainty}}",
	"=\\frac{L_{\\text{DINO}}}{2\\sigma^2}",
	"+\\lambda_{\\text{prior}}\\log\\sigma .",
	"\\]",
	"",
	"Here \\(\\sigma\\) is predicted uncertainty."
].join("\n");

function extract(src) {
	const { MathX } = loadPlugin();
	return plain(MathX.extract(src));
}

const tex = (r) => r.math.map((m) => [m.tex, m.display]);

test("Maths: delimiters", () => {
	let r = extract("Inline \\(x^2\\) and $a_b$, shown \\[\n\\frac{1}{2}\n\\] and $$\n\\sum_i i\n$$");
	assert.equal(r.text, "Inline \uE0000\uE001 and \uE0001\uE001, shown \uE0002\uE001 and \uE0003\uE001");
	assert.deepEqual(tex(r), [["x^2", false], ["a_b", false], ["\n\\frac{1}{2}\n", true], ["\n\\sum_i i\n", true]]);
	assert.equal(r.math[0].raw, "\\(x^2\\)");

	r = extract("\\begin{align}a&=b\\\\c&=d\\end{align} and \\begin{equation*}e\\end{equation*}");
	assert.deepEqual(tex(r), [["\\begin{align}a&=b\\\\c&=d\\end{align}", true], ["\\begin{equation*}e\\end{equation*}", true]]);

	// An escaped \) or $ inside a formula doesn't end it
	assert.deepEqual(tex(extract("\\(a \\\\) b\\)")), [["a \\\\) b", false]]);
	assert.deepEqual(tex(extract("$\\$5 + x$")), [["\\$5 + x", false]]);
});

test("Maths: prices, escapes, code and citations stay text", () => {
	for (const src of ["It costs $5 and $10.", "Between $5-$10 per month", "$ 5 and 6 $", "a $x\n\ny$ b",
		"Unclosed \\(x and \\[y", "$$ $$"]) {
		const r = extract(src);
		assert.equal(r.math.length, 0, src);
	}
	assert.equal(extract("It costs \\$5, or \\$6").text, "It costs $5, or $6");
	assert.equal(extract("see \\[1\\] and \\[2, 3\\]").text, "see [1] and [2, 3]");

	let src = "Use `$x$` or `` \\(y\\) ``:\n\n```\n$a$ \\(b\\)\n```\n\n~~~~\n$c$\n~~~~\n$d$";
	let r = extract(src);
	assert.deepEqual(tex(r), [["d", false]], "only the formula outside code");
	assert.equal(r.text, src.replace("$d$", "\uE0000\uE001"));
	// An unclosed code fence runs to the end, as in the renderer
	assert.equal(extract("```\n$x$").math.length, 0);

	// The model can't fake a placeholder
	assert.equal(extract("\uE0000\uE001").text, "\uFFFD0\uFFFD");
});

test("Maths: rendered in the chat", () => {
	let html = md("Energy \\(E=mc^2\\) and *snake_case_name* \\(a_1 * b_1 * c\\).");
	assert.equal((html.match(/class="katex"/g) || []).length, 2);
	assert.match(html, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML">/, "MathML for screen readers");
	assert.match(html, /<annotation encoding="application\/x-tex">E=mc\^2<\/annotation>/);
	assert.match(html, /<em>snake_case_name<\/em>/);
	assert.doesNotMatch(html, /\\\(|\\\)/, "no delimiters left");

	// A displayed equation is a block of its own, without empty lines around it
	html = md("We get\n\\[\n\\frac{a}{b}\n\\]\nso on");
	assert.match(html, /^<p>We get<span class="katex-display">[\s\S]*<\/span>so on<\/p>$/);
	assert.doesNotMatch(html, /<br>/);

	// The answer that showed raw LaTeX in the screenshot
	html = md(SCREENSHOT_ANSWER);
	assert.doesNotMatch(html, /aichat-math-error/);
	assert.equal((html.match(/class="katex"/g) || []).length, 4);
	assert.equal((html.match(/class="katex-display"/g) || []).length, 1);
	assert.match(html, /<strong>after<\/strong>/);
	assert.match(html, /Eqs\. 8–9, §3\.3, pp\. 5–6/);

	// Inside lists, tables, headings, quotes and links
	html = md("- item \\(x\\)\n\n| A | B |\n|---|---|\n| \\(a|b\\) | 2 |\n\n## On \\(y\\)\n\n> quote \\(z\\)\n\n[\\(w\\)](https://e.org)");
	assert.equal((html.match(/class="katex"/g) || []).length, 5);
	assert.match(html, /<td><span class="katex">.*<\/td><td>2<\/td>/, "a | inside a formula isn't a column");
	assert.match(html, /<a class="aichat-link"[^>]*><span class="katex">/);
});

test("Maths: invalid LaTeX is shown as written", () => {
	const html = md("Broken \\(\\frac{a\\) here");
	assert.match(html, /<code class="aichat-math-error" title="This formula couldn't be shown: [^"]+">\\\(\\frac\{a\\\)<\/code> here/);
	assert.doesNotMatch(html, /class="katex"/);
});

test("Maths: formulas can't inject links, images or styles", () => {
	const html = md("\\(\\href{javascript:alert(1)}{x} \\url{https://e.org} \\includegraphics{https://e.org/i.png}"
		+ " \\htmlStyle{background:url(https://e.org)}{y} \\htmlClass{aichat-root}{z}\\)");
	// (The LaTeX itself is kept as text in the MathML annotation, which is fine)
	const markup = html.replace(/(<annotation[^>]*>)[\s\S]*?(<\/annotation>)/g, "$1$2");
	assert.doesNotMatch(markup, /href=|src=|<a |<img|url\(|class="aichat-root"|javascript/);
	assert.match(markup, /\\href/, "the commands are shown as unsupported");

	// The cleaner removes anything KaTeX itself wouldn't make
	const { MathX, dom } = loadPlugin();
	const doc = dom.window.document;
	const span = doc.createElement("span");
	span.innerHTML = '<span style="color:red" onclick="x()">a</span><img src="x" onerror="y()"><a href="https://e.org">b</a>'
		+ '<span style="background:URL(https://e.org/t)">c</span><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/>'
		+ '<foreignObject><span>d</span></foreignObject><use href="#x"/></svg><math><maction>e</maction><mi>f</mi></math>';
	assert.equal(MathX.clean(span), true);
	assert.equal(span.innerHTML, '<span style="color:red">a</span><span>c</span><svg xmlns="http://www.w3.org/2000/svg">'
		+ '<path d="M0 0"></path></svg><math><mi>f</mi></math>');
	assert.equal(MathX.clean(doc.createElement("img")), false);
});

test("Maths: saved notes use the note editor's math markup", () => {
	assert.equal(md("Intro \\(x_1\\) and $y$.\n\n\\[\n\\frac{a}{b}\n\\]\n\nAfter", { forNote: true }),
		'<p>Intro <span class="math">$x_1$</span> and <span class="math">$y$</span>.</p>'
		+ '<pre class="math">$$\\frac{a}{b}$$</pre><p>After</p>');
	// An equation in the middle of a paragraph splits it
	assert.equal(md("We have\n$$a=b$$\nso **c**", { forNote: true }),
		'<p>We have</p><pre class="math">$$a=b$$</pre><p>so <strong>c</strong></p>');
	// Where a block can't go, a displayed equation is written inline (single $: what the editor reads there)
	assert.equal(md("- item \\[a\\]", { forNote: true }), '<ul><li>item <span class="math">$a$</span></li></ul>');
	assert.equal(md("Even \\(\\frac{a\\) is kept", { forNote: true }), '<p>Even <span class="math">$\\frac{a$</span> is kept</p>');
});

test("Maths: streaming partial input never throws, and formulas are cached", () => {
	const { MD, MathX, dom } = loadPlugin();
	const doc = dom.window.document;
	const src = SCREENSHOT_ANSWER + "\n\n$$a$$ `code $x$` $5 \\begin{align}b\\end{align}";
	for (let i = 0; i <= src.length; i++) {
		MD.render(doc, doc.createElement("div"), src.slice(0, i));
		MD.render(doc, doc.createElement("div"), src.slice(0, i), { forNote: true });
	}
	const before = MathX.cache.size;
	MD.render(doc, doc.createElement("div"), SCREENSHOT_ANSWER);
	assert.equal(MathX.cache.size, before, "every formula was already rendered");
	assert.ok(MathX.cache.size <= MathX.CACHE_SIZE);

	assert.equal(MathX.render("\\frac{a}{b}", true), MathX.render("\\frac{a}{b}", true), "the second time comes from the cache");
	assert.notEqual(MathX.render("x", true), MathX.render("x", false), "inline and displayed are cached apart");

	MathX.CACHE_SIZE = 3;
	for (let i = 0; i < 10; i++) MathX.render("x_" + i, false);
	assert.deepEqual([...MathX.cache.keys()], ["Ix_7", "Ix_8", "Ix_9"]);
	MathX.render("x_7", false);
	MathX.render("x_10", false);
	assert.deepEqual([...MathX.cache.keys()], ["Ix_9", "Ix_7", "Ix_10"], "the least recently used is dropped");
});

test("Maths: copying a selection gives each formula as LaTeX", () => {
	const { MD, dom } = loadPlugin();
	const doc = dom.window.document;
	const div = doc.createElement("div");
	MD.render(doc, div, "Energy \\(E=mc^2\\) here.\n\n\\[\n\\frac{a}{b}\n\\]\n\n- one \\(x\\)\n- two\n\n"
		+ "| A | B |\n|---|---|\n| 1 | \\(y\\) |\n\nLine\nbreak");
	assert.equal(MD.plainText(div), "Energy $E=mc^2$ here.\n\n$$\\frac{a}{b}$$\n\none $x$\ntwo\n\nA\tB\n1\t$y$\n\nLine\nbreak");
});

test("Maths: KaTeX's stylesheet uses the bundled fonts", () => {
	const { MathX } = loadPlugin();
	const css = fs.readFileSync(path.join(__dirname, "../src/content/katex/katex.min.css"), "utf8");
	const out = MathX.adaptCSS(css, "jar:file:///p/x.xpi!/content/katex/fonts/");
	assert.doesNotMatch(out, /url\(fonts\/|\.woff\)|\.ttf\)|(^|\})body\{/);
	const fonts = [...out.matchAll(/url\("jar:file:\/\/\/p\/x\.xpi!\/content\/katex\/fonts\/([^"]+)"\) format\("woff2"\)/g)].map((m) => m[1]);
	assert.equal(fonts.length, 20);
	const bundled = fs.readdirSync(path.join(__dirname, "../src/content/katex/fonts"));
	for (const font of fonts) assert.ok(bundled.includes(font), font);
	assert.equal((out.match(/url\(/g) || []).length, 20, "no other URLs");
	assert.match(out, /\.aichat-root\{counter-reset:katexEqnNo mmlEqnNo\}/);
});

// ---------------------------------------------------------------------------

(async () => {
	let failed = 0;
	for (const t of tests) {
		try {
			await t.fn();
			console.log(`  ok   ${t.name}`);
		}
		catch (e) {
			failed++;
			console.log(`  FAIL ${t.name}\n       ${(e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")}`);
		}
	}
	console.log(`\n${tests.length - failed}/${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
