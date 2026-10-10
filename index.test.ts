import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Account,
	type AccountManager,
	buildMulticodexProviderConfig,
	createStreamWrapper,
	extractQuotaResetAt,
	getNextResetAt,
	getOpenAICodexMirror,
	getWeeklyResetAt,
	isQuotaErrorMessage,
	isUsageUntouched,
	parseCodexUsageResponse,
	pickBestAccount,
} from "./index";

let previousAgentDir: string | undefined;
let agentDir: string;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "pi-multicodex-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

describe("isQuotaErrorMessage", () => {
	it("matches 429", () => {
		expect(isQuotaErrorMessage("HTTP 429 Too Many Requests")).toBe(true);
	});

	it("matches common quota / usage limit messages", () => {
		expect(isQuotaErrorMessage("You have hit your ChatGPT usage limit.")).toBe(
			true,
		);
		expect(isQuotaErrorMessage("Quota exceeded")).toBe(true);
	});

	it("matches rate limit phrasing", () => {
		expect(isQuotaErrorMessage("rate limit exceeded")).toBe(true);
		expect(isQuotaErrorMessage("Rate-Limit: exceeded")).toBe(true);
	});

	it("matches plural limit reached phrasing", () => {
		expect(isQuotaErrorMessage("limits reached")).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isQuotaErrorMessage("network error")).toBe(false);
		expect(isQuotaErrorMessage("bad request")).toBe(false);
	});
});

describe("extractQuotaResetAt", () => {
	const now = 1_700_000_000_000;

	it("extracts reset timestamps from structured fields", () => {
		expect(extractQuotaResetAt({ resets_at: 1_700_000_300 }, now)).toBe(
			1_700_000_300_000,
		);
		expect(extractQuotaResetAt({ resets_in_seconds: 225 }, now)).toBe(
			now + 225_000,
		);
	});

	it("extracts primary reset headers from embedded Codex JSON", () => {
		const error = new Error(
			'Codex error: {"status_code":429,"headers":{"X-Codex-Primary-Reset-After-Seconds":"300"}}',
		);

		expect(extractQuotaResetAt(error, now)).toBe(now + 300_000);
	});

	it("extracts primary reset-at headers from response metadata", () => {
		expect(
			extractQuotaResetAt(
				{
					response: {
						headers: { "x-codex-primary-reset-at": "2023-11-14T22:18:20Z" },
					},
				},
				now,
			),
		).toBe(1_700_000_300_000);
	});

	it("extracts friendly try-again text", () => {
		expect(
			extractQuotaResetAt(
				"You have hit your ChatGPT usage limit. Try again in ~225 min.",
				now,
			),
		).toBe(now + 225 * 60_000);
	});

	it("ignores malformed and past reset hints", () => {
		expect(
			extractQuotaResetAt({ resets_at: "not-a-date" }, now),
		).toBeUndefined();
		expect(
			extractQuotaResetAt({ resets_at: now - 60_000 }, now),
		).toBeUndefined();
	});
});

describe("getOpenAICodexMirror", () => {
	it("mirrors the openai-codex provider models exactly (metadata)", () => {
		const sourceModels = getModels("openai-codex");
		const expected = {
			baseUrl: sourceModels[0]?.baseUrl || "https://chatgpt.com/backend-api",
			models: sourceModels.map((m) => ({
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				thinkingLevelMap: m.thinkingLevelMap,
				input: m.input,
				cost: m.cost,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				...(m.headers ? { headers: m.headers } : {}),
				...(m.compat ? { compat: m.compat } : {}),
			})),
		};

		expect(getOpenAICodexMirror()).toEqual(expected);
	});

	it("preserves source model thinkingLevelMap metadata", () => {
		const sourceWithMap = getModels("openai-codex").find(
			(model) => model.thinkingLevelMap,
		);
		expect(sourceWithMap).toBeDefined();

		const mirrored = getOpenAICodexMirror().models.find(
			(model) => model.id === sourceWithMap?.id,
		);
		expect(mirrored?.thinkingLevelMap).toEqual(sourceWithMap?.thinkingLevelMap);
		expect(mirrored?.thinkingLevelMap).not.toBe(
			sourceWithMap?.thinkingLevelMap,
		);
	});
});

describe("buildMulticodexProviderConfig", () => {
	it("uses mirrored models and baseUrl", () => {
		const mirror = getOpenAICodexMirror();
		const fakeManager = {
			getActiveAccount: () => ({
				accessToken: "test-jwt.eyJ0ZXN0IjoxfQ.sig",
				needsReauth: false,
			}),
			getAccounts: () => [],
		} as unknown as AccountManager;
		const config = buildMulticodexProviderConfig(fakeManager);

		expect(config.api).toBe("openai-codex-responses");
		expect(config.apiKey).toBe("test-jwt.eyJ0ZXN0IjoxfQ.sig");
		expect(config.baseUrl).toBe(mirror.baseUrl);
		expect(config.models).toEqual(mirror.models);
		expect(typeof config.streamSimple).toBe("function");
	});
});

function makeAccount(email: string, overrides?: Partial<Account>): Account {
	return {
		email,
		accessToken: "token",
		refreshToken: "refresh",
		expiresAt: 0,
		...overrides,
	};
}

type StreamWrapper = ReturnType<typeof createStreamWrapper>;
type StreamModel = Parameters<StreamWrapper>[0];
type StreamContext = Parameters<StreamWrapper>[1];
type StreamOptions = Parameters<StreamWrapper>[2];
type BaseProvider = Parameters<typeof createStreamWrapper>[1];

describe("usage helpers", () => {
	it("parses usage response windows", () => {
		const response = parseCodexUsageResponse({
			rate_limit: {
				primary_window: {
					reset_at: 1700000000,
					used_percent: 12.5,
				},
				secondary_window: {
					reset_at: 1700003600,
					used_percent: 0,
				},
			},
		});

		expect(response.primary?.usedPercent).toBe(12.5);
		expect(response.primary?.resetAt).toBe(1700000000 * 1000);
		expect(response.secondary?.usedPercent).toBe(0);
		expect(response.secondary?.resetAt).toBe(1700003600 * 1000);
	});

	it("recognizes a weekly-only primary API window", () => {
		const response = parseCodexUsageResponse({
			rate_limit: {
				primary_window: {
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_at: 1700003600,
					used_percent: 19,
				},
				secondary_window: undefined,
			},
		});

		expect(response.primary).toBeUndefined();
		expect(response.secondary?.usedPercent).toBe(19);
		expect(response.secondary?.resetAt).toBe(1700003600 * 1000);
	});

	it("detects untouched usage", () => {
		expect(
			isUsageUntouched({
				primary: { usedPercent: 0, resetAt: 1 },
				secondary: { usedPercent: 0, resetAt: 2 },
				fetchedAt: 0,
			}),
		).toBe(true);
		expect(
			isUsageUntouched({
				primary: { usedPercent: 0, resetAt: 1 },
				secondary: { usedPercent: 5, resetAt: 2 },
				fetchedAt: 0,
			}),
		).toBe(false);
	});

	it("picks earliest reset from usage", () => {
		expect(
			getNextResetAt({
				primary: { resetAt: 2000 },
				secondary: { resetAt: 1000 },
				fetchedAt: 0,
			}),
		).toBe(1000);
	});

	it("picks weekly reset from usage", () => {
		expect(
			getWeeklyResetAt({
				primary: { resetAt: 2000 },
				secondary: { resetAt: 1000 },
				fetchedAt: 0,
			}),
		).toBe(1000);
	});
});

describe("pickBestAccount", () => {
	it("prefers untouched accounts when available", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 10, resetAt: 5000 },
					secondary: { usedPercent: 10, resetAt: 6000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 0, resetAt: 4000 },
					secondary: { usedPercent: 0, resetAt: 7000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("b");
	});

	it("prefers earliest weekly reset when all accounts touched", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 10, resetAt: 5000 },
					secondary: { usedPercent: 10, resetAt: 8000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 20, resetAt: 3000 },
					secondary: { usedPercent: 20, resetAt: 9000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("a");
	});

	it("ignores 5h reset and prefers earliest weekly reset", () => {
		const accounts = [makeAccount("sh01"), makeAccount("hind")];
		const usage = new Map([
			[
				"sh01",
				{
					primary: { usedPercent: 0, resetAt: 60 * 60 * 1000 },
					secondary: { usedPercent: 9, resetAt: 5 * 24 * 60 * 60 * 1000 },
					fetchedAt: 0,
				},
			],
			[
				"hind",
				{
					primary: { usedPercent: 24, resetAt: 55 * 60 * 1000 },
					secondary: { usedPercent: 13, resetAt: 6 * 24 * 60 * 60 * 1000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("sh01");
	});

	it("falls back to available account when usage is unknown", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const selected = pickBestAccount(accounts, new Map(), { now: 0 });
		expect(["a", "b"]).toContain(selected?.email);
	});

	it("tries accounts with unknown usage before reusing a touched known account", () => {
		const accounts = [makeAccount("known"), makeAccount("unknown")];
		const usage = new Map([
			[
				"known",
				{
					primary: { usedPercent: 25, resetAt: 5000 },
					secondary: { usedPercent: 25, resetAt: 6000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("unknown");
	});

	it("ignores exhausted accounts", () => {
		const accounts = [
			makeAccount("a", { quotaExhaustedUntil: 2000 }),
			makeAccount("b"),
		];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 0, resetAt: 1000 },
					secondary: { usedPercent: 0, resetAt: 1000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 1000 });
		expect(selected?.email).toBe("b");
	});

	it("prefers lower usage over earlier weekly reset", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 90, resetAt: 5000 },
					secondary: { usedPercent: 80, resetAt: 6000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 5, resetAt: 5000 },
					secondary: { usedPercent: 10, resetAt: 9000 },
					fetchedAt: 0,
				},
			],
		]);

		// Account b has much lower usage (10%) even though its weekly
		// reset is later (9000 vs 6000). Should pick b.
		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("b");
	});

	it("uses weekly reset as tiebreaker when usage is equal", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 30, resetAt: 5000 },
					secondary: { usedPercent: 30, resetAt: 8000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 30, resetAt: 5000 },
					secondary: { usedPercent: 30, resetAt: 7000 },
					fetchedAt: 0,
				},
			],
		]);

		// Same max usage (30%), so tiebreak on weekly reset.
		// b resets at 7000 < a at 8000, so pick b.
		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("b");
	});
});

describe("manual account selection", () => {
	it("prefers the manual account in stream wrapper", async () => {
		const manual = makeAccount("manual@example.com");
		let activateCalled = false;
		let headerEmail: string | undefined;

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => manual,
			hasManualAccount: () => true,
			clearManualAccount: () => {},
			activateBestAccount: async () => {
				activateCalled = true;
				return undefined;
			},
			ensureValidToken: async () => "manual-token",
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headerEmail = model.headers?.["X-Multicodex-Account"];
				async function* inner() {
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const _event of stream) {
			// drain
		}

		expect(activateCalled).toBe(false);
		expect(headerEmail).toBe("manual@example.com");
	});

	it("falls back to auto selection when manual is unavailable", async () => {
		const auto = makeAccount("auto@example.com");
		let cleared = false;
		let headerEmail: string | undefined;

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => true,
			clearManualAccount: () => {
				cleared = true;
			},
			activateBestAccount: async () => auto,
			ensureValidToken: async () => "auto-token",
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headerEmail = model.headers?.["X-Multicodex-Account"];
				async function* inner() {
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const _event of stream) {
			// drain
		}

		expect(cleared).toBe(true);
		expect(headerEmail).toBe("auto@example.com");
	});

	it.each([
		undefined,
		"sse",
		"auto",
		"websocket",
		"websocket-cached",
	] as const)("preserves transport %s and isolates credentials without mutating inputs", async (transport) => {
		const account = makeAccount("auto@example.com");
		const captured: Array<{
			headers?: Record<string, string>;
			apiKey?: string;
			customOption?: string;
			transport?: string;
			cacheRetention?: string;
			sessionId?: string;
		}> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async () => account,
			ensureValidToken: async () => "selected-token",
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				options?: {
					apiKey?: string;
					customOption?: string;
					transport?: string;
					cacheRetention?: string;
					sessionId?: string;
				},
			) => {
				captured.push({
					headers: model.headers,
					apiKey: options?.apiKey,
					customOption: options?.customOption,
					transport: options?.transport,
					cacheRetention: options?.cacheRetention,
					sessionId: options?.sessionId,
				});
				async function* inner() {
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const model = {
			id: "test",
			provider: "openai-codex",
			api: "openai-codex-responses",
			headers: { Existing: "yes" },
		} as unknown as StreamModel;
		const options = {
			apiKey: "original-token",
			customOption: "preserved",
			transport,
			cacheRetention: "long",
			sessionId: "caller-session",
		} as StreamOptions & { customOption: string };

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(model, {} as StreamContext, options);

		for await (const _event of stream) {
			// drain
		}

		expect(captured).toEqual([
			{
				headers: {
					Existing: "yes",
					"X-Multicodex-Account": "auto@example.com",
				},
				apiKey: "selected-token",
				customOption: "preserved",
				transport,
				cacheRetention: "none",
				sessionId: "caller-session",
			},
		]);
		expect(model.headers).toEqual({ Existing: "yes" });
		expect(options.apiKey).toBe("original-token");
		expect(options.transport).toBe(transport);
		expect(options.cacheRetention).toBe("long");
		expect(options.sessionId).toBe("caller-session");
	});

	it("clears manual on quota and retries with auto account", async () => {
		const manual = makeAccount("manual@example.com");
		const auto = makeAccount("auto@example.com");
		let cleared = false;
		let activateCount = 0;
		const headers: string[] = [];
		const runtimeAccounts: string[] = [];
		let streamCalls = 0;

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => (cleared ? undefined : manual),
			hasManualAccount: () => !cleared,
			clearManualAccount: () => {
				cleared = true;
			},
			activateBestAccount: async () => {
				activateCount += 1;
				return auto;
			},
			ensureValidToken: async (account: Account) => `${account.email}-token`,
			setRuntimeActiveAccount: (email: string) => {
				runtimeAccounts.push(email);
			},
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headers.push(model.headers?.["X-Multicodex-Account"] || "");
				streamCalls += 1;
				async function* inner() {
					if (streamCalls === 1) {
						yield { type: "error", error: { errorMessage: "quota exceeded" } };
						return;
					}
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
			{ sessionId: "quota-session" } as StreamOptions,
		);

		for await (const _event of stream) {
			// drain
		}

		expect(cleared).toBe(true);
		expect(headers[0]).toBe("manual@example.com");
		expect(headers[1]).toBe("auto@example.com");
		expect(runtimeAccounts).toEqual(["manual@example.com", "auto@example.com"]);
		expect(activateCount).toBe(1);
	});

	it("rotates when quota failure is thrown during initial stream", async () => {
		const first = makeAccount("first@example.com");
		const second = makeAccount("second@example.com");
		let activateCount = 0;
		const headers: string[] = [];
		const exhausted: string[] = [];
		const events: Array<{ type?: string }> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async (options?: {
				excludeEmails?: Set<string>;
			}) => {
				activateCount += 1;
				return options?.excludeEmails?.has(first.email) ? second : first;
			},
			ensureValidToken: async (account: Account) => `${account.email}-token`,
			handleQuotaExceeded: async (account: Account) => {
				exhausted.push(account.email);
			},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headers.push(model.headers?.["X-Multicodex-Account"] || "");
				async function* inner() {
					if (model.headers?.["X-Multicodex-Account"] === first.email) {
						throw new Error("limits reached after 3 retries");
					}
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
			{ sessionId: "thrown-quota-session" } as StreamOptions,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(headers).toEqual(["first@example.com", "second@example.com"]);
		expect(exhausted).toEqual(["first@example.com"]);
		expect(activateCount).toBe(2);
		expect(events.some((event) => event.type === "error")).toBe(false);
	});

	it("rotates when quota metadata refresh also hits quota", async () => {
		const first = makeAccount("first@example.com");
		const second = makeAccount("second@example.com");
		let activateCount = 0;
		const headers: string[] = [];
		const events: Array<{ type?: string }> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async (options?: {
				excludeEmails?: Set<string>;
			}) => {
				activateCount += 1;
				return options?.excludeEmails?.has(first.email) ? second : first;
			},
			ensureValidToken: async (account: Account) => `${account.email}-token`,
			handleQuotaExceeded: async () => {
				throw new Error(
					'Codex error: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"},"status_code":429}',
				);
			},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headers.push(model.headers?.["X-Multicodex-Account"] || "");
				async function* inner() {
					if (model.headers?.["X-Multicodex-Account"] === first.email) {
						throw new Error(
							'Codex error: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"},"status_code":429}',
						);
					}
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(headers).toEqual(["first@example.com", "second@example.com"]);
		expect(activateCount).toBe(2);
		expect(events.some((event) => event.type === "error")).toBe(false);
	});

	it("rotates when a synthetic start precedes a quota error", async () => {
		const first = makeAccount("first@example.com");
		const second = makeAccount("second@example.com");
		let activateCount = 0;
		const headers: string[] = [];
		const exhausted: string[] = [];
		const events: Array<{ type?: string }> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async (options?: {
				excludeEmails?: Set<string>;
			}) => {
				activateCount += 1;
				return options?.excludeEmails?.has(first.email) ? second : first;
			},
			ensureValidToken: async (account: Account) => `${account.email}-token`,
			handleQuotaExceeded: async (account: Account) => {
				exhausted.push(account.email);
			},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headers.push(model.headers?.["X-Multicodex-Account"] || "");
				async function* inner() {
					if (model.headers?.["X-Multicodex-Account"] === first.email) {
						yield { type: "start", partial: {} };
						yield {
							type: "error",
							error: { errorMessage: "You have hit your ChatGPT usage limit." },
						};
						return;
					}
					yield { type: "start", partial: {} };
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
			{ sessionId: "buffered-start-quota-session" } as StreamOptions,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(headers).toEqual(["first@example.com", "second@example.com"]);
		expect(exhausted).toEqual(["first@example.com"]);
		expect(activateCount).toBe(2);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
	});

	it.each([
		"text_start",
		"thinking_start",
		"toolcall_start",
	])("rotates when %s precedes a quota error", async (preOutputType) => {
		const first = makeAccount("first@example.com");
		const second = makeAccount("second@example.com");
		let activateCount = 0;
		const headers: string[] = [];
		const exhausted: string[] = [];
		const events: Array<{ type?: string }> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async (options?: {
				excludeEmails?: Set<string>;
			}) => {
				activateCount += 1;
				return options?.excludeEmails?.has(first.email) ? second : first;
			},
			ensureValidToken: async (account: Account) => `${account.email}-token`,
			handleQuotaExceeded: async (account: Account) => {
				exhausted.push(account.email);
			},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (model: { headers?: Record<string, string> }) => {
				headers.push(model.headers?.["X-Multicodex-Account"] || "");
				async function* inner() {
					if (model.headers?.["X-Multicodex-Account"] === first.email) {
						yield { type: preOutputType };
						yield { type: "error", error: { errorMessage: "quota exceeded" } };
						return;
					}
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(headers).toEqual(["first@example.com", "second@example.com"]);
		expect(exhausted).toEqual(["first@example.com"]);
		expect(activateCount).toBe(2);
		expect(events.map((event) => event.type)).toEqual(["done"]);
	});

	it.each([
		"text_delta",
		"thinking_delta",
		"toolcall_delta",
		"toolcall_end",
	])("does not rotate after meaningful %s output", async (outputType) => {
		const account = makeAccount("first@example.com");
		let activateCount = 0;
		const exhausted: string[] = [];
		const events: Array<{ type?: string }> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async () => {
				activateCount += 1;
				return account;
			},
			ensureValidToken: async () => "token",
			handleQuotaExceeded: async (exhaustedAccount: Account) => {
				exhausted.push(exhaustedAccount.email);
			},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: () => {
				async function* inner() {
					yield { type: "text_start" };
					yield { type: outputType };
					yield { type: "error", error: { errorMessage: "quota exceeded" } };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(activateCount).toBe(1);
		expect(exhausted).toEqual([]);
		expect(events.map((event) => event.type)).toEqual([
			"text_start",
			outputType,
			"error",
		]);
	});

	it("treats unknown non-terminal events as meaningful output", async () => {
		const account = makeAccount("first@example.com");
		let activateCount = 0;
		const exhausted: string[] = [];
		const events: Array<{ type?: string }> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async () => {
				activateCount += 1;
				return account;
			},
			ensureValidToken: async () => "token",
			handleQuotaExceeded: async (exhaustedAccount: Account) => {
				exhausted.push(exhaustedAccount.email);
			},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: () => {
				async function* inner() {
					yield { type: "future_event" };
					yield { type: "error", error: { errorMessage: "quota exceeded" } };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(activateCount).toBe(1);
		expect(exhausted).toEqual([]);
		expect(events.map((event) => event.type)).toEqual([
			"future_event",
			"error",
		]);
	});

	it("replays buffered pre-output events once before the first meaningful output", async () => {
		const account = makeAccount("first@example.com");
		let activateCount = 0;
		const events: Array<{ type?: string }> = [];

		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async () => {
				activateCount += 1;
				return account;
			},
			ensureValidToken: async () => "token",
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: () => {
				async function* inner() {
					yield { type: "start" };
					yield { type: "text_start" };
					yield { type: "thinking_start" };
					yield { type: "text_delta" };
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(activateCount).toBe(1);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"thinking_start",
			"text_delta",
			"done",
		]);
	});

	it("skips auth-broken accounts before streaming and retries a healthy one", async () => {
		const broken = makeAccount("broken@example.com");
		const healthy = makeAccount("healthy@example.com");
		let activateCount = 0;
		const headers: string[] = [];
		const events: Array<{ type?: string }> = [];

		const notifyRotationSkipForAuthFailure = vi.fn();
		const accountManager = {
			waitUntilReady: async () => {},
			syncImportedOpenAICodexAuth: async () => false,
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => false,
			clearManualAccount: () => {},
			activateBestAccount: async (options?: {
				excludeEmails?: Set<string>;
			}) => {
				activateCount += 1;
				return options?.excludeEmails?.has(broken.email) ? healthy : broken;
			},
			ensureValidToken: async (account: Account) => {
				if (account.email === broken.email) {
					throw new Error("refresh failed");
				}
				return "healthy-token";
			},
			notifyRotationSkipForAuthFailure,
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headers.push(model.headers?.["X-Multicodex-Account"] || "");
				async function* inner() {
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<{ type: string }>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "openai-codex",
				api: "openai-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const event of stream) {
			events.push(event as { type?: string });
		}

		expect(activateCount).toBe(2);
		expect(headers).toEqual(["healthy@example.com"]);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(notifyRotationSkipForAuthFailure).toHaveBeenCalledWith(
			broken,
			expect.any(Error),
		);
	});
});
