import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentPath } from "./agent-paths";
import type { Account } from "./storage";
import { acquireFileLock } from "./usage-cache";

const ENTRY_TYPE = "multicodex-session-account";
const ACCOUNT_KEY = /^[a-f0-9]{64}$/;

function accountKey(account: Account): string {
	return createHash("sha256").update(account.email).digest("hex");
}

function nextAccount(accounts: Account[], after?: string): Account | undefined {
	const ordered = accounts.map((account) => ({
		account,
		key: accountKey(account),
	}));
	ordered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return (
		ordered.find(({ key }) => after !== undefined && key > after) ?? ordered[0]
	)?.account;
}

export class SessionRotation {
	private readonly sessionId: string;
	private readonly lifecycle = new AbortController();
	private key?: string;

	constructor(
		private readonly pi: Pick<ExtensionAPI, "appendEntry">,
		session: Pick<
			ExtensionContext["sessionManager"],
			"getSessionId" | "getEntries"
		>,
		private readonly warn: (message: string) => void,
	) {
		this.sessionId = session.getSessionId();
		// This assignment follows the whole session, not one conversation branch.
		for (const entry of session.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data;
			if (
				data &&
				typeof data === "object" &&
				"sessionId" in data &&
				data.sessionId === this.sessionId &&
				"key" in data &&
				typeof data.key === "string" &&
				ACCOUNT_KEY.test(data.key)
			) {
				this.key = data.key;
			}
		}
	}

	get signal(): AbortSignal {
		return this.lifecycle.signal;
	}

	close(): void {
		this.lifecycle.abort();
	}

	getAccount(accounts: Account[]): Account | undefined {
		if (!this.key) return undefined;
		return accounts.find((account) => accountKey(account) === this.key);
	}

	async select(
		getEligible: () => Account[],
		requestSignal?: AbortSignal,
	): Promise<Account | undefined> {
		const signal = requestSignal
			? AbortSignal.any([requestSignal, this.lifecycle.signal])
			: this.lifecycle.signal;
		signal.throwIfAborted();
		if (this.key) return this.keepOrReplace(getEligible());
		if (getEligible().length === 0) return undefined;

		const file = getAgentPath("codex-rotation");
		let release: (() => Promise<void>) | undefined;
		let selected: Account | undefined;
		try {
			try {
				release = await acquireFileLock(`${file}.lock`, signal);
				if (!release) throw new Error("Cannot lock the rotation cursor");
				signal.throwIfAborted();
				if (this.key) return this.keepOrReplace(getEligible());

				let after: string | undefined;
				try {
					after = (await readFile(file, "utf8")).trim();
					if (!ACCOUNT_KEY.test(after)) {
						after = undefined;
						this.warn(
							"Multicodex: invalid rotation cursor; restarting the rotation order.",
						);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				signal.throwIfAborted();
				selected = nextAccount(getEligible(), after);
				if (!selected) return undefined;
				const temporary = `${file}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporary, `${accountKey(selected)}\n`, {
						flag: "wx",
						mode: 0o600,
					});
					signal.throwIfAborted();
					await rename(temporary, file);
				} finally {
					await unlink(temporary).catch(() => undefined);
				}
			} catch (error) {
				signal.throwIfAborted();
				this.warn(
					`Multicodex: could not update the rotation cursor: ${String(error)}`,
				);
			}
			signal.throwIfAborted();
			const eligible = getEligible();
			return this.assign(
				this.getAccount(eligible) ??
					(selected && eligible.includes(selected)
						? selected
						: nextAccount(eligible, this.key)),
			);
		} finally {
			await release?.();
		}
	}

	private keepOrReplace(eligible: Account[]): Account | undefined {
		return (
			this.getAccount(eligible) ?? this.assign(nextAccount(eligible, this.key))
		);
	}

	private assign(account: Account | undefined): Account | undefined {
		if (!account) return undefined;
		const key = accountKey(account);
		if (key !== this.key) {
			this.pi.appendEntry(ENTRY_TYPE, { sessionId: this.sessionId, key });
			this.key = key;
		}
		return account;
	}
}
