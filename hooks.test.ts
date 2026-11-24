import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "./hooks";

function fixture() {
	return {
		loadPiAuth: vi.fn().mockResolvedValue(undefined),
		getAccountsNeedingReauth: vi.fn().mockReturnValue([]),
		getAvailableManualAccount: vi.fn(),
		hasManualAccount: vi.fn(),
		clearManualAccount: vi.fn(),
		refreshUsageForAccount: vi.fn(),
		activateBestAccount: vi.fn(),
		beginInitialization: vi.fn(),
		markReady: vi.fn(),
	};
}

describe("handleSessionStart", () => {
	it("imports auth without taking a turn in the rotation", async () => {
		const manager = fixture();
		handleSessionStart(manager as never);
		await vi.waitFor(() => expect(manager.markReady).toHaveBeenCalled());
		expect(manager.loadPiAuth).toHaveBeenCalledOnce();
		expect(manager.activateBestAccount).not.toHaveBeenCalled();
	});

	it("refreshes an available manual account without selecting automatically", async () => {
		const manager = fixture();
		const manual = { email: "manual@example.com" };
		manager.getAvailableManualAccount.mockReturnValue(manual);
		handleSessionStart(manager as never);
		await vi.waitFor(() => expect(manager.markReady).toHaveBeenCalled());
		expect(manager.refreshUsageForAccount).toHaveBeenCalledWith(manual);
		expect(manager.activateBestAccount).not.toHaveBeenCalled();
	});

	it("clears an unavailable manual override without selecting automatically", async () => {
		const manager = fixture();
		manager.hasManualAccount.mockReturnValue(true);
		handleSessionStart(manager as never);
		await vi.waitFor(() => expect(manager.markReady).toHaveBeenCalled());
		expect(manager.clearManualAccount).toHaveBeenCalledOnce();
		expect(manager.activateBestAccount).not.toHaveBeenCalled();
	});

	it("marks ready even when auth import fails", async () => {
		const manager = fixture();
		manager.loadPiAuth.mockRejectedValue(new Error("network failure"));
		handleSessionStart(manager as never);
		await vi.waitFor(() => expect(manager.markReady).toHaveBeenCalled());
	});
});
