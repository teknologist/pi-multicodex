import { describe, expect, it, vi } from "vitest";
import { handleNewSessionSwitch, handleSessionStart } from "./hooks";

describe("handleSessionStart", () => {
	it.each([
		{ accounts: [] },
		{ accounts: [{ email: "a@example.com" }] },
	])("imports auth and activates without a manual account (stored accounts: %j)", async ({
		accounts,
	}) => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAccount = vi.fn().mockResolvedValue(undefined);
		const getAvailableManualAccount = vi.fn().mockReturnValue(undefined);
		const hasManualAccount = vi.fn().mockReturnValue(false);
		const clearManualAccount = vi.fn();
		const selected = { email: "selected@example.com" };
		const activateBestAccount = vi.fn().mockResolvedValue(selected);
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleSessionStart({
			getAccounts: () => accounts,
			loadPiAuth,
			isPiAuthAccount: () => false,
			refreshUsageForAccount,
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount,
			hasManualAccount,
			clearManualAccount,
			activateBestAccount,
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(beginInitialization).toHaveBeenCalled();
			expect(loadPiAuth).toHaveBeenCalled();
			expect(getAvailableManualAccount).toHaveBeenCalled();
			expect(hasManualAccount).toHaveBeenCalled();
			expect(clearManualAccount).not.toHaveBeenCalled();
			expect(activateBestAccount).toHaveBeenCalledWith({
				refreshUsage: false,
			});
			expect(refreshUsageForAccount).toHaveBeenCalledWith(selected);
			expect(markReady).toHaveBeenCalled();
		});
	});

	it("keeps the manual account when one is available", async () => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAccount = vi.fn().mockResolvedValue(undefined);
		const manual = { email: "manual@example.com" };
		const getAvailableManualAccount = vi.fn().mockReturnValue(manual);
		const hasManualAccount = vi.fn();
		const clearManualAccount = vi.fn();
		const activateBestAccount = vi.fn();
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleSessionStart({
			getAccounts: () => [{ email: "manual@example.com" }],
			loadPiAuth,
			isPiAuthAccount: () => false,
			refreshUsageForAccount,
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount,
			hasManualAccount,
			clearManualAccount,
			activateBestAccount,
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(beginInitialization).toHaveBeenCalled();
			expect(loadPiAuth).toHaveBeenCalled();
			expect(getAvailableManualAccount).toHaveBeenCalled();
			expect(refreshUsageForAccount).toHaveBeenCalledWith(manual);
			expect(hasManualAccount).not.toHaveBeenCalled();
			expect(clearManualAccount).not.toHaveBeenCalled();
			expect(activateBestAccount).not.toHaveBeenCalled();
			expect(markReady).toHaveBeenCalled();
		});
	});
});

describe("handleNewSessionSwitch", () => {
	it("refreshes and clears stale manual state before activating the best account", async () => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAccount = vi.fn().mockResolvedValue(undefined);
		const getAvailableManualAccount = vi.fn().mockReturnValue(undefined);
		const hasManualAccount = vi.fn().mockReturnValue(true);
		const clearManualAccount = vi.fn();
		const selected = { email: "selected@example.com" };
		const activateBestAccount = vi.fn().mockResolvedValue(selected);
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleNewSessionSwitch({
			loadPiAuth,
			isPiAuthAccount: () => false,
			refreshUsageForAccount,
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount,
			hasManualAccount,
			clearManualAccount,
			activateBestAccount,
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(beginInitialization).toHaveBeenCalled();
			expect(loadPiAuth).toHaveBeenCalled();
			expect(getAvailableManualAccount).toHaveBeenCalled();
			expect(hasManualAccount).toHaveBeenCalled();
			expect(clearManualAccount).toHaveBeenCalled();
			expect(activateBestAccount).toHaveBeenCalledWith({
				refreshUsage: false,
			});
			expect(refreshUsageForAccount).toHaveBeenCalledWith(selected);
			expect(markReady).toHaveBeenCalled();
		});
	});

	it("marks ready even when the refresh throws", async () => {
		const loadPiAuth = vi.fn().mockRejectedValue(new Error("network failure"));
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleNewSessionSwitch({
			loadPiAuth,
			isPiAuthAccount: () => false,
			refreshUsageForAccount: vi.fn(),
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount: vi.fn(),
			hasManualAccount: vi.fn(),
			clearManualAccount: vi.fn(),
			activateBestAccount: vi.fn(),
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(markReady).toHaveBeenCalled();
		});
	});
});
