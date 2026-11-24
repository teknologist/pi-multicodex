import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	registerCommands: vi.fn(),
	handleSessionStart: vi.fn(),
	setSessionRotation: vi.fn(),
	installMulticodexProviderWrapper: vi.fn(),
	setWarningHandler: vi.fn(),
	resetSessionWarnings: vi.fn(),
	statusRefreshFor: vi.fn(),
	statusStartAutoRefresh: vi.fn(),
	statusStopAutoRefresh: vi.fn(),
	statusDispose: vi.fn(),
	statusLoadPreferences: vi.fn().mockResolvedValue(undefined),
	statusScheduleModelSelectRefresh: vi.fn(),
}));

vi.mock("./account-manager", () => ({
	AccountManager: class MockAccountManager {
		setWarningHandler = mocks.setWarningHandler;
		resetSessionWarnings = mocks.resetSessionWarnings;
		setSessionRotation = mocks.setSessionRotation;
	},
}));

vi.mock("./commands", () => ({
	registerCommands: mocks.registerCommands,
}));

vi.mock("./hooks", () => ({
	handleSessionStart: mocks.handleSessionStart,
}));

vi.mock("./provider", () => ({
	installMulticodexProviderWrapper: mocks.installMulticodexProviderWrapper,
}));

vi.mock("./status", () => ({
	createUsageStatusController: () => ({
		loadPreferences: mocks.statusLoadPreferences,
		refreshFor: mocks.statusRefreshFor,
		scheduleModelSelectRefresh: mocks.statusScheduleModelSelectRefresh,
		startAutoRefresh: mocks.statusStartAutoRefresh,
		stopAutoRefresh: mocks.statusStopAutoRefresh,
		dispose: mocks.statusDispose,
	}),
}));

import multicodexExtension from "./extension";

const sessionManager = { getSessionId: () => "session", getEntries: () => [] };

describe("multicodexExtension", () => {
	beforeEach(() => {
		mocks.registerCommands.mockClear();
		mocks.handleSessionStart.mockClear();
		mocks.setSessionRotation.mockClear();
		mocks.installMulticodexProviderWrapper.mockClear();
		mocks.setWarningHandler.mockClear();
		mocks.resetSessionWarnings.mockClear();
		mocks.statusRefreshFor.mockClear();
		mocks.statusStartAutoRefresh.mockClear();
		mocks.statusStopAutoRefresh.mockClear();
		mocks.statusDispose.mockClear();
		mocks.statusLoadPreferences.mockClear();
		mocks.statusScheduleModelSelectRefresh.mockClear();
	});

	it("registers provider, commands, and lifecycle hooks", () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const registerProvider = vi.fn();
		const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			handlers.set(event, handler);
		});

		multicodexExtension({
			registerProvider,
			on,
		} as never);

		expect(mocks.setWarningHandler).toHaveBeenCalledOnce();
		expect(mocks.installMulticodexProviderWrapper).toHaveBeenCalledOnce();
		expect(mocks.installMulticodexProviderWrapper).toHaveBeenCalledWith(
			expect.objectContaining({ registerProvider }),
			expect.any(Object),
		);
		expect(mocks.registerCommands).toHaveBeenCalledOnce();
		expect(on).toHaveBeenCalledTimes(4);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_switch")).toBe(false);
		expect(handlers.has("turn_end")).toBe(true);
		expect(handlers.has("model_select")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
	});

	it("routes session and status events to the helpers", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctx = { ui: { notify: vi.fn() }, sessionManager };

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		const sessionStart = handlers.get("session_start");
		const turnEnd = handlers.get("turn_end");
		const modelSelect = handlers.get("model_select");
		const sessionShutdown = handlers.get("session_shutdown");
		expect(sessionStart).toBeTypeOf("function");
		expect(turnEnd).toBeTypeOf("function");
		expect(modelSelect).toBeTypeOf("function");
		expect(sessionShutdown).toBeTypeOf("function");

		sessionStart?.({ reason: "startup" }, ctx as never);
		expect(mocks.installMulticodexProviderWrapper).toHaveBeenCalledTimes(2);
		expect(mocks.resetSessionWarnings).toHaveBeenCalledTimes(1);
		expect(mocks.handleSessionStart).toHaveBeenCalledOnce();
		expect(mocks.statusStartAutoRefresh).toHaveBeenCalledOnce();
		await vi.waitFor(() => {
			expect(mocks.statusLoadPreferences).toHaveBeenCalledWith(ctx);
			expect(mocks.statusRefreshFor).toHaveBeenCalledWith(ctx);
		});

		sessionStart?.({ reason: "new" }, ctx as never);
		expect(mocks.installMulticodexProviderWrapper).toHaveBeenCalledTimes(3);
		expect(mocks.resetSessionWarnings).toHaveBeenCalledTimes(2);
		expect(mocks.handleSessionStart).toHaveBeenCalledTimes(2);
		expect(mocks.statusStartAutoRefresh).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => {
			expect(mocks.statusRefreshFor).toHaveBeenCalledTimes(2);
		});

		turnEnd?.({}, ctx as never);
		modelSelect?.({}, ctx as never);
		expect(mocks.statusRefreshFor).toHaveBeenCalledTimes(3);
		expect(mocks.statusScheduleModelSelectRefresh).toHaveBeenCalledWith(ctx);

		sessionShutdown?.({}, ctx as never);
		expect(mocks.statusDispose).toHaveBeenCalledWith(ctx);
		expect(mocks.setWarningHandler).toHaveBeenLastCalledWith(undefined);
	});

	it("swallows stale-context warning notifications", () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let warningHandler: ((message: string) => void) | undefined;
		mocks.setWarningHandler.mockImplementation((handler) => {
			warningHandler = handler;
		});
		const staleCtx = {
			sessionManager,
			ui: {
				notify: vi.fn(() => {
					throw new Error(
						"This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
					);
				}),
			},
		};

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		handlers.get("session_start")?.({}, staleCtx as never);
		expect(() => warningHandler?.("reauth required")).not.toThrow();
	});

	it("swallows current pi stale ctx warning notifications", () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let warningHandler: ((message: string) => void) | undefined;
		mocks.setWarningHandler.mockImplementation((handler) => {
			warningHandler = handler;
		});
		const staleCtx = {
			sessionManager,
			ui: {
				notify: vi.fn(() => {
					throw new Error(
						"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
					);
				}),
			},
		};

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		handlers.get("session_start")?.({}, staleCtx as never);
		expect(() => warningHandler?.("reauth required")).not.toThrow();
	});
});
