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

// Objects created inside the vm context have that context's prototypes, which strict
// deep-equality treats as different; compare plain copies instead
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadPlugin(prefs = {}) {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const logs = [];
	const Zotero = {
		Prefs: { get: (key) => prefs[key.replace("extensions.zotero-ai-chat.", "")] },
		debug: (msg) => logs.push(String(msg)),
		logError: (e) => logs.push(String(e)),
		launchURL: (url) => logs.push("launch:" + url),
		Utilities: { unescapeHTML: (s) => s.replace(/<[^>]+>/g, ""), Internal: {} }
	};
	const context = {
		Zotero,
		Services: {},
		DOMParser: dom.window.DOMParser,
		TextDecoder,
		setTimeout,
		clearTimeout,
		console
	};
	vm.createContext(context);
	vm.runInContext(SOURCE, context, { filename: "aichat.js" });
	return { AIChat: context.AIChat, MD: context.AIChatMarkdown, dom, logs, prefs };
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
			const call = { url, opts, headers: opts.headers, body: JSON.parse(opts.body) };
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

// ---------------------------------------------------------------------------
// Conversation flow (send) with a fake item and window

function setupSend(prefs, handler) {
	const env = loadPlugin({
		provider: "anthropic",
		"anthropic.apiKey": "k",
		"anthropic.model": "claude-opus-5-5",
		"anthropic.baseURL": "https://proxy.example",
		"anthropic.effort": "medium",
		...prefs
	});
	let contextBuilds = 0;
	env.AIChat.buildContext = async () => {
		contextBuilds++;
		return CONTEXT;
	};
	const win = fakeWin(handler);
	const item = { id: 42 };
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
