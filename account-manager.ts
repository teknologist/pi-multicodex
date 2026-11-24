import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { loadImportedOpenAICodexAuth } from "./auth";
import { refreshOAuthToken } from "./oauth-client";
import { extractQuotaResetAt } from "./quota";
import { isAccountAvailable, pickBestAccount } from "./selection";
import type { SessionRotation } from "./session-rotation";
import {
	type Account,
	loadStorage,
	type StorageData,
	saveStorage,
} from "./storage";
import { normalizeUnknownError } from "./stream-utils";
import { type CodexUsageSnapshot, getNextResetAt } from "./usage";
import {
	getOrFetchSharedUsage,
	getSharedUsageKey,
	loadSharedUsageCache,
} from "./usage-cache";
import { fetchCodexUsage } from "./usage-client";

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_REQUEST_TIMEOUT_MS = 10 * 1000;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

type WarningHandler = (message: string) => void;
type StateChangeHandler = () => void;

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || /\babort(?:ed)?\b/i.test(error.message);
}

function isTerminalTokenRefreshError(error: unknown): boolean {
	const message = normalizeUnknownError(error);
	if (/OpenAI Codex token refresh failed \((?:5\d\d|429)\)/i.test(message)) {
		return false;
	}
	return (
		/\binvalid_grant\b/i.test(message) ||
		/\binvalid_refresh_token\b/i.test(message) ||
		/\brefresh token\b.*\b(?:expired|invalid|revoked|used)\b/i.test(message) ||
		/OpenAI Codex token refresh failed \((?:400|401|403)\)/i.test(message)
	);
}

export class AccountManager {
	private data: StorageData;
	private piAuthAccount?: Account;
	private usageCache = new Map<string, CodexUsageSnapshot>();
	private refreshPromises = new Map<string, Promise<string>>();
	private warningHandler?: WarningHandler;
	private manualEmail?: string;
	private runtimeActiveEmail?: string;
	private sessionRotation?: SessionRotation;

	private stateChangeHandlers = new Set<StateChangeHandler>();
	private warnedAuthFailureEmails = new Set<string>();
	private readyPromise: Promise<void> = Promise.resolve();
	private readyResolve?: () => void;

	constructor() {
		this.data = loadStorage();
		const sharedUsage = loadSharedUsageCache();
		const now = Date.now();
		for (const account of this.data.accounts) {
			const usage = sharedUsage.get(getSharedUsageKey(account));
			if (usage && now - usage.fetchedAt < USAGE_CACHE_TTL_MS) {
				this.usageCache.set(account.email, usage);
			}
		}
	}

	/**
	 * Mark the account manager as initializing. The returned promise
	 * resolves when {@link markReady} is called. Stream requests wait
	 * on {@link waitUntilReady} so they don't race the startup refresh.
	 */
	beginInitialization(): void {
		this.readyPromise = new Promise<void>((resolve) => {
			this.readyResolve = resolve;
		});
	}

	markReady(): void {
		this.readyResolve?.();
		this.readyResolve = undefined;
	}

	waitUntilReady(): Promise<void> {
		return this.readyPromise;
	}

	private save(): void {
		saveStorage(this.data);
	}

	private saveManagedAccount(account: Account): void {
		if (this.isPiAuthAccount(account)) return;

		const latest = loadStorage();
		const accountId = account.accountId;
		const index = latest.accounts.findIndex(
			(candidate) =>
				candidate.email === account.email ||
				(Boolean(accountId) && candidate.accountId === accountId),
		);
		if (index >= 0) {
			latest.accounts[index] = account;
		} else {
			latest.accounts.push(account);
		}
		latest.activeEmail =
			this.piAuthAccount?.email === this.data.activeEmail
				? latest.activeEmail
				: this.data.activeEmail;
		this.data = latest;
		saveStorage(this.data);
	}

	private notifyStateChanged(): void {
		for (const handler of this.stateChangeHandlers) {
			handler();
		}
	}

	onStateChange(handler: StateChangeHandler): () => void {
		this.stateChangeHandlers.add(handler);
		return () => {
			this.stateChangeHandlers.delete(handler);
		};
	}

	getAccounts(): Account[] {
		if (this.piAuthAccount) {
			return [...this.data.accounts, this.piAuthAccount];
		}
		return this.data.accounts;
	}

	getAccount(email: string): Account | undefined {
		if (this.piAuthAccount?.email === email) return this.piAuthAccount;
		return this.data.accounts.find((a) => a.email === email);
	}

	isPiAuthAccount(account: Account): boolean {
		return this.piAuthAccount !== undefined && account === this.piAuthAccount;
	}

	setWarningHandler(handler?: WarningHandler): void {
		this.warningHandler = handler;
	}

	setSessionRotation(rotation?: SessionRotation): void {
		this.sessionRotation?.close();
		this.sessionRotation = rotation;
		this.runtimeActiveEmail = undefined;
	}

	resetSessionWarnings(): void {
		this.warnedAuthFailureEmails.clear();
	}

	notifyRotationSkipForAuthFailure(account: Account, error: unknown): void {
		if (this.warnedAuthFailureEmails.has(account.email)) {
			return;
		}
		this.warnedAuthFailureEmails.add(account.email);
		const hint = this.isPiAuthAccount(account)
			? "/login openai-codex"
			: `/multicodex reauth ${account.email}`;
		this.warningHandler?.(
			`Multicodex skipped ${account.email} during rotation: ${normalizeUnknownError(error)}. Account is flagged in /multicodex accounts. Run ${hint} to repair it.`,
		);
	}

	private removeAccountRecord(account: Account): boolean {
		const index = this.data.accounts.findIndex(
			(candidate) => candidate.email === account.email,
		);
		if (index < 0) return false;
		const removedEmail = this.data.accounts[index]?.email;
		this.data.accounts.splice(index, 1);
		if (removedEmail) {
			this.usageCache.delete(removedEmail);
			if (this.manualEmail === removedEmail) {
				this.manualEmail = undefined;
			}
			if (this.runtimeActiveEmail === removedEmail) {
				this.runtimeActiveEmail = undefined;
			}
			if (this.data.activeEmail === removedEmail) {
				this.data.activeEmail = this.data.accounts[0]?.email;
			}
		}
		return true;
	}

	private applyCredentials(account: Account, creds: OAuthCredentials): boolean {
		const accountId =
			typeof creds.accountId === "string" ? creds.accountId : undefined;
		let changed = false;
		if (account.accessToken !== creds.access) {
			account.accessToken = creds.access;
			changed = true;
		}
		if (account.refreshToken !== creds.refresh) {
			account.refreshToken = creds.refresh;
			changed = true;
		}
		if (account.expiresAt !== creds.expires) {
			account.expiresAt = creds.expires;
			changed = true;
		}
		if (accountId && account.accountId !== accountId) {
			account.accountId = accountId;
			changed = true;
		}
		if (account.needsReauth) {
			account.needsReauth = undefined;
			this.warnedAuthFailureEmails.delete(account.email);
			changed = true;
		}
		return changed;
	}

	private tokenIsFresh(account: Account): boolean {
		return Date.now() < account.expiresAt - TOKEN_REFRESH_SKEW_MS;
	}

	private credentialsAreFresh(creds: OAuthCredentials): boolean {
		return Date.now() < creds.expires - TOKEN_REFRESH_SKEW_MS;
	}

	private shouldMergeImportedCredentials(
		account: Account,
		creds: OAuthCredentials,
	): boolean {
		if (!this.credentialsAreFresh(creds)) return false;
		return creds.expires > account.expiresAt || Boolean(account.needsReauth);
	}

	private findManagedAccountForImported(
		imported: Awaited<ReturnType<typeof loadImportedOpenAICodexAuth>>,
	): Account | undefined {
		if (!imported) return undefined;
		const importedAccountId =
			typeof imported.credentials.accountId === "string"
				? imported.credentials.accountId
				: undefined;
		return this.data.accounts.find(
			(a) =>
				a.email === imported.identifier ||
				(Boolean(importedAccountId) && a.accountId === importedAccountId),
		);
	}

	private mergeImportedAuthIntoManaged(
		imported: Awaited<ReturnType<typeof loadImportedOpenAICodexAuth>>,
	): Account | undefined {
		const account = this.findManagedAccountForImported(imported);
		if (!account || !imported) return undefined;

		const changed = this.shouldMergeImportedCredentials(
			account,
			imported.credentials,
		)
			? this.applyCredentials(account, imported.credentials)
			: false;
		if (changed) {
			this.saveManagedAccount(account);
			this.notifyStateChanged();
		}
		return account;
	}

	private reloadManagedAccountFromStorage(account: Account): boolean {
		if (this.isPiAuthAccount(account)) return false;
		const latest = loadStorage();
		const accountId = account.accountId;
		const stored = latest.accounts.find(
			(candidate) =>
				candidate.email === account.email ||
				(Boolean(accountId) && candidate.accountId === accountId),
		);
		if (!stored) return false;

		const hasFresherCredentials =
			stored.expiresAt > account.expiresAt ||
			(stored.expiresAt >= account.expiresAt &&
				(stored.accessToken !== account.accessToken ||
					stored.refreshToken !== account.refreshToken));
		const hasRecoveredReauth =
			account.needsReauth && !stored.needsReauth && this.tokenIsFresh(stored);
		if (!hasFresherCredentials && !hasRecoveredReauth) return false;

		let changed = this.applyCredentials(account, {
			access: stored.accessToken,
			refresh: stored.refreshToken,
			expires: stored.expiresAt,
			accountId: stored.accountId,
		});
		if (account.lastUsed !== stored.lastUsed) {
			account.lastUsed = stored.lastUsed;
			changed = true;
		}
		if (account.quotaExhaustedUntil !== stored.quotaExhaustedUntil) {
			account.quotaExhaustedUntil = stored.quotaExhaustedUntil;
			changed = true;
		}
		if (changed) {
			this.notifyStateChanged();
		}
		return changed;
	}

	private async mergePiAuthForManagedAccount(
		account: Account,
	): Promise<boolean> {
		if (this.isPiAuthAccount(account)) return false;
		const imported = await loadImportedOpenAICodexAuth();
		const importedAccountId =
			typeof imported?.credentials.accountId === "string"
				? imported.credentials.accountId
				: undefined;
		if (
			!imported ||
			(account.email !== imported.identifier &&
				(!importedAccountId || account.accountId !== importedAccountId))
		) {
			return false;
		}

		if (!this.shouldMergeImportedCredentials(account, imported.credentials)) {
			return false;
		}

		const changed = this.applyCredentials(account, imported.credentials);
		if (changed) {
			this.saveManagedAccount(account);
			this.notifyStateChanged();
		}
		return changed;
	}

	addOrUpdateAccount(email: string, creds: OAuthCredentials): Account {
		const existing = this.data.accounts.find((a) => a.email === email);
		if (existing) {
			const changed = this.applyCredentials(existing, creds);
			if (changed) {
				this.save();
				this.notifyStateChanged();
			}
			return existing;
		}

		const account: Account = {
			email,
			accessToken: creds.access,
			refreshToken: creds.refresh,
			expiresAt: creds.expires,
			accountId:
				typeof creds.accountId === "string" ? creds.accountId : undefined,
		};
		this.data.accounts.push(account);
		this.setActiveAccount(email);
		return account;
	}

	getActiveAccount(): Account | undefined {
		const manual = this.getManualAccount();
		if (manual) return manual;
		const assigned = this.sessionRotation?.getAccount(this.getAccounts());
		if (assigned) return assigned;
		if (this.data.activeEmail) {
			return this.getAccount(this.data.activeEmail);
		}
		return this.data.accounts[0];
	}

	getDisplayAccount(): Account | undefined {
		const runtimeAccount = this.runtimeActiveEmail
			? this.getAccount(this.runtimeActiveEmail)
			: undefined;
		return runtimeAccount ?? this.getActiveAccount();
	}

	setRuntimeActiveAccount(email: string): void {
		if (!this.getAccount(email)) return;
		if (this.runtimeActiveEmail === email) return;
		this.runtimeActiveEmail = email;
		this.notifyStateChanged();
	}

	getManualAccount(): Account | undefined {
		if (!this.manualEmail) return undefined;
		const account = this.getAccount(this.manualEmail);
		if (!account) {
			this.manualEmail = undefined;
			return undefined;
		}
		return account;
	}

	hasManualAccount(): boolean {
		return Boolean(this.manualEmail);
	}

	setActiveAccount(email: string): void {
		this.runtimeActiveEmail = undefined;
		this.data.activeEmail = email;
		this.save();
		this.notifyStateChanged();
	}

	setManualAccount(email: string): void {
		const account = this.getAccount(email);
		if (!account) return;
		this.runtimeActiveEmail = undefined;
		this.manualEmail = email;
		account.lastUsed = Date.now();
		this.notifyStateChanged();
	}

	clearManualAccount(): void {
		if (!this.manualEmail) return;
		this.runtimeActiveEmail = undefined;
		this.manualEmail = undefined;
		this.notifyStateChanged();
	}

	/**
	 * Read pi's openai-codex auth from auth.json and expose it as a
	 * memory-only ephemeral account. Never persists to codex-accounts.json.
	 * If the identity already exists as a managed account, merge the fresh
	 * pi credentials into the managed record instead of creating an ephemeral
	 * duplicate.
	 */
	async loadPiAuth(): Promise<void> {
		const imported = await loadImportedOpenAICodexAuth();
		if (!imported) {
			this.piAuthAccount = undefined;
			this.notifyStateChanged();
			return;
		}

		const managed = this.mergeImportedAuthIntoManaged(imported);
		if (managed) {
			this.piAuthAccount = undefined;
			return;
		}

		const importedAccountId =
			typeof imported.credentials.accountId === "string"
				? imported.credentials.accountId
				: undefined;

		this.piAuthAccount = {
			email: imported.identifier,
			accessToken: imported.credentials.access,
			refreshToken: imported.credentials.refresh,
			expiresAt: imported.credentials.expires,
			accountId: importedAccountId,
		};
		this.notifyStateChanged();
	}

	getAvailableManualAccount(options?: {
		excludeEmails?: Set<string>;
		now?: number;
	}): Account | undefined {
		const manual = this.getManualAccount();
		if (!manual) return undefined;
		const now = options?.now ?? Date.now();
		if (!isAccountAvailable(manual, now)) return undefined;
		if (options?.excludeEmails?.has(manual.email)) return undefined;
		return manual;
	}

	markExhausted(email: string, until: number): void {
		const account = this.getAccount(email);
		if (account) {
			account.quotaExhaustedUntil = until;
			if (!this.isPiAuthAccount(account)) {
				this.saveManagedAccount(account);
			}
			this.notifyStateChanged();
		}
	}

	clearAllQuotaExhaustion(): number {
		let cleared = 0;
		let managedChanged = false;
		for (const account of this.getAccounts()) {
			if (account.quotaExhaustedUntil) {
				account.quotaExhaustedUntil = undefined;
				cleared += 1;
				if (!this.isPiAuthAccount(account)) {
					managedChanged = true;
				}
			}
		}
		if (managedChanged) {
			this.save();
		}
		if (cleared > 0) {
			this.notifyStateChanged();
		}
		return cleared;
	}

	removeAccount(email: string): boolean {
		const account = this.getAccount(email);
		if (!account) return false;
		const removed = this.removeAccountRecord(account);
		if (!removed) return false;
		this.save();
		this.notifyStateChanged();
		return true;
	}

	getCachedUsage(email: string): CodexUsageSnapshot | undefined {
		return this.usageCache.get(email);
	}

	getAccountsNeedingReauth(): Account[] {
		return this.data.accounts.filter((a) => a.needsReauth);
	}

	private markNeedsReauth(account: Account): void {
		if (
			this.reloadManagedAccountFromStorage(account) &&
			this.tokenIsFresh(account)
		) {
			return;
		}
		account.needsReauth = true;
		if (!this.isPiAuthAccount(account)) {
			this.saveManagedAccount(account);
		}
		this.notifyStateChanged();
	}

	async refreshUsageForAccount(
		account: Account,
		options?: { force?: boolean; signal?: AbortSignal },
	): Promise<CodexUsageSnapshot | undefined> {
		if (account.needsReauth) return this.usageCache.get(account.email);

		const cached = this.usageCache.get(account.email);
		const now = Date.now();
		if (
			cached &&
			!options?.force &&
			now - cached.fetchedAt < USAGE_CACHE_TTL_MS
		) {
			return cached;
		}

		try {
			const usage = await getOrFetchSharedUsage(
				account,
				async () => {
					const token = await this.ensureValidToken(account);
					return fetchCodexUsage(token, account.accountId, {
						signal: options?.signal,
						timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
					});
				},
				{
					ttlMs: USAGE_CACHE_TTL_MS,
					force: options?.force,
					signal: options?.signal,
				},
			);
			this.usageCache.set(account.email, usage);
			this.notifyStateChanged();
			return usage;
		} catch (error) {
			if (options?.signal?.aborted || isAbortError(error)) {
				return undefined;
			}
			this.warningHandler?.(
				`Multicodex: failed to fetch usage for ${account.email}: ${normalizeUnknownError(
					error,
				)}`,
			);
			return undefined;
		}
	}

	async refreshUsageForAllAccounts(options?: {
		force?: boolean;
		signal?: AbortSignal;
	}): Promise<void> {
		const accounts = this.getAccounts();
		await Promise.all(
			accounts.map((account) => this.refreshUsageForAccount(account, options)),
		);
	}

	async refreshUsageIfStale(
		accounts: Account[],
		options?: { signal?: AbortSignal },
	): Promise<void> {
		const now = Date.now();
		const stale = accounts.filter((account) => {
			const cached = this.usageCache.get(account.email);
			return !cached || now - cached.fetchedAt >= USAGE_CACHE_TTL_MS;
		});
		if (stale.length === 0) return;
		await Promise.all(
			stale.map((account) => this.refreshUsageForAccount(account, options)),
		);
	}

	async activateBestAccount(
		options?: {
			excludeEmails?: Set<string>;
			signal?: AbortSignal;
			refreshUsage?: boolean;
		},
		rotation = this.sessionRotation,
	): Promise<Account | undefined> {
		if (rotation) {
			return rotation.select(() => {
				const now = Date.now();
				return this.getAccounts().filter(
					(account) =>
						isAccountAvailable(account, now) &&
						!options?.excludeEmails?.has(account.email),
				);
			}, options?.signal);
		}

		const now = Date.now();
		this.clearExpiredExhaustion(now);
		const accounts = this.getAccounts();
		if (options?.refreshUsage !== false) {
			await this.refreshUsageIfStale(accounts, options);
		}

		const selected = pickBestAccount(accounts, this.usageCache, {
			excludeEmails: options?.excludeEmails,
			now,
		});
		if (selected) {
			if (this.isPiAuthAccount(selected)) {
				// Don't persist ephemeral pi auth email to disk — it would
				// become a stale activeEmail after restart.
				this.data.activeEmail = selected.email;
				this.notifyStateChanged();
			} else {
				this.setActiveAccount(selected.email);
			}
		}
		return selected;
	}

	async handleQuotaExceeded(
		account: Account,
		options?: { quotaError?: unknown; signal?: AbortSignal },
	): Promise<void> {
		const now = Date.now();
		let resetAt = extractQuotaResetAt(options?.quotaError, now);
		if (!resetAt) {
			const usage = await this.refreshUsageForAccount(account, {
				force: true,
				signal: options?.signal,
			});
			resetAt = getNextResetAt(usage);
		}
		const fallback = now + QUOTA_COOLDOWN_MS;
		const until = resetAt && resetAt > now ? resetAt : fallback;
		this.markExhausted(account.email, until);
	}

	private clearExpiredExhaustion(now: number): void {
		let managedChanged = false;
		let anyChanged = false;
		for (const account of this.getAccounts()) {
			if (account.quotaExhaustedUntil && account.quotaExhaustedUntil <= now) {
				account.quotaExhaustedUntil = undefined;
				anyChanged = true;
				if (!this.isPiAuthAccount(account)) {
					managedChanged = true;
				}
			}
		}
		if (managedChanged) {
			this.save();
		}
		if (anyChanged) {
			this.notifyStateChanged();
		}
	}

	async ensureValidToken(account: Account): Promise<string> {
		if (account.needsReauth) {
			await this.mergePiAuthForManagedAccount(account);
			this.reloadManagedAccountFromStorage(account);
			if (!account.needsReauth && this.tokenIsFresh(account)) {
				return account.accessToken;
			}
			const hint = this.isPiAuthAccount(account)
				? "/login openai-codex"
				: `/multicodex use ${account.email}`;
			throw new Error(
				`${account.email}: re-authentication required — run ${hint}`,
			);
		}

		if (this.tokenIsFresh(account)) {
			return account.accessToken;
		}

		if (this.isPiAuthAccount(account)) {
			return this.ensureValidTokenForPiAuth(account);
		}

		await this.mergePiAuthForManagedAccount(account);
		this.reloadManagedAccountFromStorage(account);
		if (this.tokenIsFresh(account)) {
			return account.accessToken;
		}

		const inflight = this.refreshPromises.get(account.email);
		if (inflight) {
			return inflight;
		}

		const promise = (async () => {
			try {
				const result = await refreshOAuthToken(account.refreshToken);
				account.accessToken = result.access;
				account.refreshToken = result.refresh;
				account.expiresAt = result.expires;
				const accountId =
					typeof result.accountId === "string" ? result.accountId : undefined;
				if (accountId) {
					account.accountId = accountId;
				}
				this.saveManagedAccount(account);
				this.notifyStateChanged();
				return account.accessToken;
			} catch (error) {
				await this.mergePiAuthForManagedAccount(account);
				this.reloadManagedAccountFromStorage(account);
				if (this.tokenIsFresh(account)) {
					return account.accessToken;
				}
				if (isTerminalTokenRefreshError(error)) {
					this.markNeedsReauth(account);
				}
				throw error;
			} finally {
				this.refreshPromises.delete(account.email);
			}
		})();

		this.refreshPromises.set(account.email, promise);
		return promise;
	}

	/**
	 * Read-only refresh for the ephemeral pi auth account.
	 * Re-reads auth.json for fresh tokens. Never writes anything.
	 */
	private async ensureValidTokenForPiAuth(account: Account): Promise<string> {
		const latest = await loadImportedOpenAICodexAuth();
		if (latest && Date.now() < latest.credentials.expires - 5 * 60 * 1000) {
			account.accessToken = latest.credentials.access;
			account.refreshToken = latest.credentials.refresh;
			account.expiresAt = latest.credentials.expires;
			const accountId =
				typeof latest.credentials.accountId === "string"
					? latest.credentials.accountId
					: undefined;
			if (accountId) {
				account.accountId = accountId;
			}
			this.notifyStateChanged();
			return account.accessToken;
		}

		this.piAuthAccount = undefined;
		this.notifyStateChanged();
		throw new Error(
			`${account.email}: pi auth expired — run /login openai-codex`,
		);
	}
}
