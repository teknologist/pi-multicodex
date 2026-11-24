import type { AccountManager } from "./account-manager";

type WarningHandler = (message: string) => void;

async function loadAccounts(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
): Promise<void> {
	accountManager.beginInitialization();
	try {
		await accountManager.loadPiAuth();

		const needsReauth = accountManager.getAccountsNeedingReauth();
		if (needsReauth.length > 0) {
			const hints = needsReauth.map((a) => {
				const cmd = accountManager.isPiAuthAccount(a)
					? "/login openai-codex"
					: `/multicodex use ${a.email}`;
				return `${a.email} (${cmd})`;
			});
			warningHandler?.(
				`Multicodex: ${needsReauth.length} account(s) need re-authentication: ${hints.join(", ")}`,
			);
		}

		const manual = accountManager.getAvailableManualAccount();
		if (manual) {
			await accountManager.refreshUsageForAccount(manual);
			return;
		}
		if (accountManager.hasManualAccount()) {
			accountManager.clearManualAccount();
		}
	} finally {
		accountManager.markReady();
	}
}

export function handleSessionStart(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
): void {
	loadAccounts(accountManager, warningHandler).catch(() => {});
}
