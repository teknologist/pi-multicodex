import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CodexUsageSnapshot } from "./usage";

const CACHE_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 15_000;

export const SHARED_USAGE_CACHE_PATH = join(
	homedir(),
	".pi",
	"agent",
	"codex-usage-cache.json",
);

interface UsageAccount {
	email: string;
	accountId?: string;
}

interface CacheData {
	version: number;
	entries: Record<string, CacheEntry>;
}

interface CacheEntry {
	revision: string;
	snapshot: CodexUsageSnapshot;
}

interface LockMetadata {
	pid: number;
	owner: string;
	createdAt: number;
}

interface SharedUsageOptions {
	filePath?: string;
	ttlMs: number;
	force?: boolean;
	signal?: AbortSignal;
	lockTimeoutMs?: number;
}

export function getSharedUsageKey(account: UsageAccount): string {
	return `email:${account.email.trim().toLowerCase()}`;
}

function parseWindow(raw: unknown): CodexUsageSnapshot["primary"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const usedPercent = record.usedPercent;
	const resetAt = record.resetAt;
	const window: NonNullable<CodexUsageSnapshot["primary"]> = {};
	if (
		typeof usedPercent === "number" &&
		Number.isFinite(usedPercent) &&
		usedPercent >= 0 &&
		usedPercent <= 100
	) {
		window.usedPercent = usedPercent;
	}
	if (typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0) {
		window.resetAt = resetAt;
	}
	return Object.keys(window).length > 0 ? window : undefined;
}

function parseSnapshot(
	raw: unknown,
	now: number,
): CodexUsageSnapshot | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (
		typeof record.fetchedAt !== "number" ||
		!Number.isFinite(record.fetchedAt) ||
		record.fetchedAt <= 0 ||
		record.fetchedAt > now
	) {
		return undefined;
	}
	return {
		primary: parseWindow(record.primary),
		secondary: parseWindow(record.secondary),
		fetchedAt: record.fetchedAt,
	};
}

function parseEntry(raw: unknown, now: number): CacheEntry | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.revision === "string") {
		const snapshot = parseSnapshot(record.snapshot, now);
		return snapshot ? { revision: record.revision, snapshot } : undefined;
	}
	const snapshot = parseSnapshot(raw, now);
	return snapshot
		? { revision: `legacy:${snapshot.fetchedAt}`, snapshot }
		: undefined;
}

function parseCache(raw: unknown, now: number): Map<string, CacheEntry> {
	const cache = new Map<string, CacheEntry>();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cache;
	const record = raw as Record<string, unknown>;
	if (record.version !== CACHE_VERSION) return cache;
	if (!record.entries || typeof record.entries !== "object") return cache;
	for (const [key, value] of Object.entries(record.entries)) {
		const entry = parseEntry(value, now);
		if (entry) cache.set(key, entry);
	}
	return cache;
}

export function loadSharedUsageCache(
	filePath = SHARED_USAGE_CACHE_PATH,
): Map<string, CodexUsageSnapshot> {
	try {
		return new Map(
			[
				...parseCache(JSON.parse(readFileSync(filePath, "utf8")), Date.now()),
			].map(([key, entry]) => [key, entry.snapshot]),
		);
	} catch {
		return new Map();
	}
}

async function readCache(filePath: string): Promise<Map<string, CacheEntry>> {
	try {
		return parseCache(JSON.parse(await readFile(filePath, "utf8")), Date.now());
	} catch {
		return new Map();
	}
}

function lockPath(filePath: string, key: string): string {
	const hash = createHash("sha256").update(key).digest("hex");
	return join(`${filePath}.locks`, `${hash}.lock`);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readLockMetadata(
	path: string,
): Promise<LockMetadata | undefined> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as LockMetadata;
		if (
			typeof raw.pid === "number" &&
			typeof raw.owner === "string" &&
			typeof raw.createdAt === "number"
		) {
			return raw;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function releaseOwnedLock(path: string, owner: string): Promise<void> {
	const current = await readLockMetadata(path);
	if (current?.owner === owner) await unlink(path).catch(() => undefined);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function reclaimAbandonedRecovery(path: string): Promise<void> {
	try {
		const metadata = await readLockMetadata(path);
		const createdAt = metadata?.createdAt ?? (await stat(path)).mtimeMs;
		if (Date.now() - createdAt <= LOCK_STALE_MS) return;
		if (metadata && processIsAlive(metadata.pid)) return;
		await unlink(path);
	} catch {
		// Another process changed the recovery marker.
	}
}

async function isReclaimableLock(path: string): Promise<boolean> {
	try {
		const metadata = await readLockMetadata(path);
		const createdAt = metadata?.createdAt ?? (await stat(path)).mtimeMs;
		if (Date.now() - createdAt <= LOCK_STALE_MS) return false;
		return !metadata || !processIsAlive(metadata.pid);
	} catch {
		return false;
	}
}

async function reclaimStaleLock(path: string): Promise<void> {
	if (!(await isReclaimableLock(path))) return;
	const recoveryPath = `${path}.reclaim`;
	const owner = randomUUID();
	try {
		await writeFile(
			recoveryPath,
			JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() }),
			{ flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			await reclaimAbandonedRecovery(recoveryPath);
		}
		return;
	}

	try {
		if (!(await isReclaimableLock(path))) return;
		const tombstone = `${path}.${randomUUID()}.stale`;
		await rename(path, tombstone);
		await unlink(tombstone).catch(() => undefined);
	} catch {
		// Another process changed the lock; retry acquisition normally.
	} finally {
		await releaseOwnedLock(recoveryPath, owner);
	}
}

export async function acquireFileLock(
	path: string,
	signal?: AbortSignal,
	timeoutMs = LOCK_WAIT_TIMEOUT_MS,
): Promise<(() => Promise<void>) | undefined> {
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	} catch {
		return undefined;
	}

	const owner = randomUUID();
	const recoveryPath = `${path}.reclaim`;
	const startedAt = performance.now();
	while (true) {
		signal?.throwIfAborted();
		if (performance.now() - startedAt >= timeoutMs) {
			throw new Error(`Timed out waiting for shared usage cache lock: ${path}`);
		}
		await reclaimAbandonedRecovery(recoveryPath);
		if (await pathExists(recoveryPath)) {
			await delay(50, undefined, { signal });
			continue;
		}
		const metadata: LockMetadata = {
			pid: process.pid,
			owner,
			createdAt: Date.now(),
		};
		try {
			await writeFile(path, JSON.stringify(metadata), {
				flag: "wx",
				mode: 0o600,
			});
			if (await pathExists(recoveryPath)) {
				await releaseOwnedLock(path, owner);
				await delay(50, undefined, { signal });
				continue;
			}
			return () => releaseOwnedLock(path, owner);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		}
		await reclaimStaleLock(path);
		await delay(50, undefined, { signal });
	}
}

async function persistSnapshot(
	filePath: string,
	key: string,
	entry: CacheEntry,
	signal?: AbortSignal,
): Promise<void> {
	const release = await acquireFileLock(lockPath(filePath, "write"), signal);
	if (!release) return;
	let temporaryPath: string | undefined;
	try {
		const cache = await readCache(filePath);
		cache.set(key, entry);
		const data: CacheData = {
			version: CACHE_VERSION,
			entries: Object.fromEntries(cache),
		};
		await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
		temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
			mode: 0o600,
		});
		await rename(temporaryPath, filePath);
		temporaryPath = undefined;
	} finally {
		if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
		await release();
	}
}

function isUsable(
	entry: CacheEntry | undefined,
	requestStartedAt: number,
	ttlMs: number,
	force: boolean,
	initialRevision?: string,
): entry is CacheEntry {
	if (!entry) return false;
	return force
		? entry.revision !== initialRevision
		: requestStartedAt - entry.snapshot.fetchedAt < ttlMs;
}

export async function getOrFetchSharedUsage(
	account: UsageAccount,
	fetchUsage: () => Promise<CodexUsageSnapshot>,
	options: SharedUsageOptions,
): Promise<CodexUsageSnapshot> {
	options.signal?.throwIfAborted();
	const filePath = options.filePath ?? SHARED_USAGE_CACHE_PATH;
	const key = getSharedUsageKey(account);
	const requestStartedAt = Date.now();
	const cached = (await readCache(filePath)).get(key);
	const initialRevision = cached?.revision;
	if (
		isUsable(
			cached,
			requestStartedAt,
			options.ttlMs,
			options.force === true,
			initialRevision,
		)
	) {
		return cached.snapshot;
	}

	const release = await acquireFileLock(
		lockPath(filePath, key),
		options.signal,
		options.lockTimeoutMs,
	);
	try {
		const refreshed = (await readCache(filePath)).get(key);
		if (
			isUsable(
				refreshed,
				requestStartedAt,
				options.ttlMs,
				options.force === true,
				initialRevision,
			)
		) {
			return refreshed.snapshot;
		}
		const usage = await fetchUsage();
		await persistSnapshot(
			filePath,
			key,
			{ revision: randomUUID(), snapshot: usage },
			options.signal,
		).catch(() => undefined);
		return usage;
	} finally {
		await release?.();
	}
}
