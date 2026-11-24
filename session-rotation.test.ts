import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "./account-manager";
import { SessionRotation } from "./session-rotation";
import type { Account } from "./storage";
import { createErrorAssistantMessage } from "./stream-utils";
import { createStreamWrapper } from "./stream-wrapper";

vi.mock("./storage", () => ({
	loadStorage: () => ({ version: 1, accounts: makeAccounts() }),
	saveStorage: () => {},
}));
vi.mock("./usage-cache", async (importOriginal) => ({
	...(await importOriginal<typeof import("./usage-cache")>()),
	loadSharedUsageCache: () => new Map(),
}));

function makeAccounts(): Account[] {
	return ["alpha@example.com", "beta@example.com"].map((email) => ({
		email,
		accessToken: `fixture-${email}`,
		refreshToken: "fixture",
		expiresAt: Date.now() + 24 * 60 * 60 * 1000,
	}));
}

const model: Model<"openai-codex-responses"> = {
	id: "fixture",
	name: "Fixture",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

let directory: string;
let requests: { account?: string; cacheKey?: string }[];
let quota = false;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "multicodex-rotation-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	requests = [];
	quota = false;
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function newSession() {
	const session = SessionManager.create(directory, directory);
	session.appendMessage({
		role: "user",
		content: "fixture",
		timestamp: Date.now(),
	});
	return session;
}

function connect(session: SessionManager) {
	const manager = new AccountManager();
	const warn = vi.fn();
	const rotation = new SessionRotation(
		{
			appendEntry: (type, data) => {
				session.appendCustomEntry(type, data);
			},
		},
		session,
		warn,
	);
	manager.setSessionRotation(rotation);
	const wrapper = createStreamWrapper(
		manager,
		{
			streamSimple: (model, _context, options) => {
				requests.push({
					account: model.headers?.["X-Multicodex-Account"],
					cacheKey: options?.sessionId,
				});
				const stream = createAssistantMessageEventStream();
				const message = createErrorAssistantMessage(
					model,
					"quota exceeded, try again in 1 hour",
				);
				if (quota) {
					quota = false;
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					const { errorMessage: _, ...rest } = message;
					stream.push({
						type: "done",
						reason: "stop",
						message: { ...rest, stopReason: "stop" },
					});
				}
				return stream;
			},
		},
		rotation,
	);
	return {
		manager,
		rotation,
		warn,
		sessionId: session.getSessionId(),
		turn: () =>
			wrapper(
				model,
				{ messages: [] },
				{ transport: "sse", sessionId: session.getSessionId() },
			).result(),
	};
}

it("rotates on first automatic use, keeps the SSE key on resume, and gives a fork its own turn", async () => {
	const first = newSession();
	const initial = connect(first);
	connect(newSession()); // Unused session must not take a turn.
	expect(existsSync(join(directory, "codex-rotation"))).toBe(false);
	expect((await initial.turn()).stopReason).toBe("stop");
	expect((await initial.turn()).stopReason).toBe("stop");
	initial.rotation.close();

	const second = connect(newSession());
	expect((await second.turn()).stopReason).toBe("stop");
	const file = first.getSessionFile();
	if (!file) throw new Error("Fixture session did not persist");
	const resumed = connect(SessionManager.open(file, directory));
	expect((await resumed.turn()).stopReason).toBe("stop");
	const leaf = first.getLeafId();
	const forkFile = leaf && first.createBranchedSession(leaf);
	if (!forkFile) throw new Error("Fixture session did not fork");
	const fork = connect(SessionManager.open(forkFile, directory));
	expect((await fork.turn()).stopReason).toBe("stop");
	const third = connect(newSession());
	expect((await third.turn()).stopReason).toBe("stop");

	expect(requests[0]?.account).toBeDefined();
	expect(requests[0]?.cacheKey).toBeDefined();
	expect(requests[1]).toEqual(requests[0]);
	expect(requests[2]?.account).not.toBe(requests[0]?.account);
	expect(requests[3]).toEqual(requests[0]);
	expect(requests[4]?.account).toBe(requests[0]?.account);
	expect(requests[4]?.cacheKey).not.toBe(requests[0]?.cacheKey);
	expect(requests[5]?.account).toBe(requests[2]?.account);
	expect(initial.warn).not.toHaveBeenCalled();
});

it("keeps the quota fallback after recovery and preserves the manual override", async () => {
	const session = newSession();
	const { manager, turn } = connect(session);
	expect((await turn()).stopReason).toBe("stop");
	quota = true;
	expect((await turn()).stopReason).toBe("stop");
	const original = requests[0]?.account;
	const fallback = requests[2]?.account;
	if (!original || !fallback)
		throw new Error("Fixture did not reach both accounts");
	expect(requests[1]).toEqual(requests[0]);
	expect(fallback).not.toBe(original);
	manager.markExhausted(original, Date.now() - 1);
	expect((await turn()).stopReason).toBe("stop");
	manager.setManualAccount(original);
	expect((await turn()).stopReason).toBe("stop");
	manager.clearManualAccount();
	expect((await turn()).stopReason).toBe("stop");
	const file = session.getSessionFile();
	if (!file) throw new Error("Fixture session did not persist");
	expect(
		(await connect(SessionManager.open(file, directory)).turn()).stopReason,
	).toBe("stop");
	expect(requests.map(({ account }) => account)).toEqual([
		original,
		original,
		fallback,
		fallback,
		original,
		fallback,
		fallback,
	]);
});

it("serializes simultaneous first requests and does not use a closed session", async () => {
	const first = connect(newSession());
	const second = connect(newSession());
	const results = await Promise.all([
		first.turn(),
		first.turn(),
		second.turn(),
	]);
	expect(results.map(({ stopReason }) => stopReason)).toEqual([
		"stop",
		"stop",
		"stop",
	]);
	const firstRequests = requests.filter(({ cacheKey }) =>
		cacheKey?.endsWith(`-${first.sessionId}`),
	);
	const secondRequest = requests.find(({ cacheKey }) =>
		cacheKey?.endsWith(`-${second.sessionId}`),
	);
	expect(firstRequests).toHaveLength(2);
	expect(firstRequests[1]).toEqual(firstRequests[0]);
	expect(secondRequest?.account).toBeDefined();
	expect(secondRequest?.account).not.toBe(firstRequests[0]?.account);
	first.rotation.close();
	expect((await first.turn()).stopReason).toBe("error");
	expect(requests).toHaveLength(3);
});
