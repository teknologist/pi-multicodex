import { zstdDecompressSync } from "node:zlib";
import type { Model } from "@earendil-works/pi-ai";
import {
	closeOpenAICodexWebSocketSessions,
	streamSimple,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountManager } from "./account-manager";
import type { Account } from "./storage";
import { createStreamWrapper } from "./stream-wrapper";

// Exercise Pi 1.1's real transport/cache logic; only replace the network boundary.
const sockets: Socket[] = [];
let response = "complete";
class Socket extends EventTarget {
	static OPEN = 1;
	readyState = 1;
	bodies: Record<string, unknown>[] = [];
	constructor(
		_url: string,
		public options: { headers: Record<string, string> },
	) {
		super();
		sockets.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	send(body: string) {
		this.bodies.push(JSON.parse(body));
		const mode = response;
		queueMicrotask(() => {
			if (mode === "wait") return;
			const payload =
				mode === "quota"
					? {
							type: "error",
							code: "usage_limit_reached",
							message: "quota exceeded",
						}
					: {
							type: "response.completed",
							response: {
								id: `response-${sockets.length}`,
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						};
			this.dispatchEvent(
				new MessageEvent("message", { data: JSON.stringify(payload) }),
			);
		});
	}
	close() {
		this.readyState = 3;
	}
}
const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "fixture",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
const context = normalizeContext({
	messages: [{ role: "user", content: "fixture", timestamp: 1 }],
});
function account(email: string, workspace = "shared-workspace"): Account {
	const payload = Buffer.from(
		JSON.stringify({
			sub: email,
			"https://api.openai.com/auth": { chatgpt_account_id: workspace },
		}),
	).toString("base64url");
	return {
		email,
		accessToken: `fixture.${payload}.signature`,
		refreshToken: "fixture",
		expiresAt: Number.MAX_SAFE_INTEGER,
	};
}
function fixture() {
	let selected = account("first@example.test");
	const manager = {
		waitUntilReady: async () => {},
		getAvailableManualAccount: () => undefined,
		hasManualAccount: () => false,
		clearManualAccount: () => {},
		activateBestAccount: async () => selected,
		ensureValidToken: async (value: Account) => value.accessToken,
		handleQuotaExceeded: async () => {
			selected = account("second@example.test");
			response = "complete";
		},
	} as unknown as AccountManager;
	return {
		stream: createStreamWrapper(manager, {
			streamSimple: (selectedModel, messages, options) =>
				streamSimple(
					{ ...selectedModel, api: "openai-codex-responses" },
					normalizeContext(messages),
					options,
				),
		}),
		select(value: Account) {
			selected = value;
		},
	};
}
beforeEach(() => {
	sockets.length = 0;
	response = "complete";
	vi.stubGlobal("WebSocket", Socket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("Unexpected SSE", { status: 500 })),
	);
});
afterEach(() => {
	for (const id of [
		"unrelated-fixture",
		"managed-fixture",
		"quota-fixture",
		"abort-fixture",
	]) {
		closeOpenAICodexWebSocketSessions(id);
	}
	vi.unstubAllGlobals();
});

it("authenticates each request anew, even when rotating within the same workspace, and preserves unrelated cached sockets", async () => {
	const unrelated = account("unrelated@example.test", "other-workspace");
	const options = {
		apiKey: unrelated.accessToken,
		sessionId: "unrelated-fixture",
		transport: "auto" as const,
	};
	expect(
		(await streamSimple(model, context, options).result()).stopReason,
	).toBe("stop");
	const kept = sockets[0];
	const target = fixture();
	const accounts = [
		account("first@example.test"),
		account("second@example.test"),
		account("third@example.test", "different-workspace"),
	];
	for (const selected of accounts) {
		target.select(selected);
		expect(
			(
				await target
					.stream(model, context, {
						sessionId: "managed-fixture",
						transport: "auto",
						cacheRetention: "long",
					})
					.result()
			).stopReason,
		).toBe("stop");
		const socket = sockets.at(-1);
		if (!socket) throw new Error("Expected a request socket");
		expect(socket.options.headers.authorization).toBe(
			`Bearer ${selected.accessToken}`,
		);
		expect(socket.bodies[0].previous_response_id).toBeUndefined();
		expect(socket.bodies[0].prompt_cache_key).toBeUndefined();
		expect(socket.readyState).toBe(3);
		expect(kept.readyState).toBe(1);
	}
	expect(sockets).toHaveLength(4);
	expect(
		(await streamSimple(model, context, options).result()).stopReason,
	).toBe("stop");
	expect(sockets).toHaveLength(4);
	expect(kept.bodies).toHaveLength(2);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("rotates a quota failure to a fresh same-workspace socket without SSE", async () => {
	response = "quota";
	const target = fixture();
	const result = await target
		.stream(model, context, { sessionId: "quota-fixture", transport: "auto" })
		.result();
	expect(result.stopReason).toBe("stop");
	expect(sockets).toHaveLength(2);
	expect(sockets.map((socket) => socket.options.headers.authorization)).toEqual(
		[
			`Bearer ${account("first@example.test").accessToken}`,
			`Bearer ${account("second@example.test").accessToken}`,
		],
	);
	expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("closes an active request socket on cancellation without another account attempt", async () => {
	response = "wait";
	const target = fixture();
	const controller = new AbortController();
	const result = target
		.stream(model, context, {
			sessionId: "abort-fixture",
			transport: "auto",
			signal: controller.signal,
		})
		.result();
	await vi.waitFor(() => expect(sockets[0]?.bodies).toHaveLength(1));
	controller.abort();
	expect((await result).stopReason).toBe("aborted");
	expect(sockets).toHaveLength(1);
	expect(sockets[0].readyState).toBe(3);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

function sseResponse() {
	const body = `data: ${JSON.stringify({
		type: "response.completed",
		response: {
			id: "response-sse",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	})}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

// Pi zstd-compresses SSE request bodies.
function requestBody(call: unknown[]): Record<string, unknown> {
	const { body } = call[1] as { body: string | Uint8Array };
	const text =
		typeof body === "string" ? body : zstdDecompressSync(body).toString();
	return JSON.parse(text);
}

// Without a prompt_cache_key Codex cache hits collapsed from ~92% to ~20%; SSE
// has no socket to share, so a per-account key keeps the cache without sharing it.
it("keeps a prompt cache key on SSE that is scoped to the selected account", async () => {
	const fetchMock = vi.fn(async () => sseResponse());
	vi.stubGlobal("fetch", fetchMock);
	const target = fixture();
	const keys: string[] = [];
	for (const email of ["first@example.test", "second@example.test"]) {
		target.select(account(email));
		const result = await target
			.stream(model, context, { sessionId: "sse-fixture", transport: "sse" })
			.result();
		expect(result.stopReason).toBe("stop");
		const key = String(
			requestBody(fetchMock.mock.calls.at(-1) ?? []).prompt_cache_key,
		);
		expect(key).toContain("sse-fixture");
		expect(key).not.toContain(email);
		keys.push(key);
	}
	expect(keys[0]).not.toBe(keys[1]);
	target.select(account("first@example.test"));
	await target
		.stream(model, context, { sessionId: "sse-fixture", transport: "sse" })
		.result();
	expect(requestBody(fetchMock.mock.calls.at(-1) ?? []).prompt_cache_key).toBe(
		keys[0],
	);
	expect(sockets).toHaveLength(0);
});
