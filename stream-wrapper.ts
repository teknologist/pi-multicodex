import { createHash } from "node:crypto";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AccountManager } from "./account-manager";
import { isQuotaErrorMessage } from "./quota";
import {
	createErrorAssistantMessage,
	createLinkedAbortController,
	normalizeUnknownError,
	rewriteProviderOnEvent,
} from "./stream-utils";

const MAX_ROTATION_RETRIES = 5;
type ApiProviderRef = {
	streamSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
};

// Pi derives the Codex prompt-cache key from sessionId and drops it when
// cacheRetention is "none". Over SSE there is no socket to leak between
// credentials, so a per-account key keeps the cache without sharing it.
function accountScopedSessionId(
	sessionId: string | undefined,
	email: string,
): string | undefined {
	if (!sessionId) return undefined;
	const tag = createHash("sha256").update(email).digest("hex").slice(0, 8);
	return `${tag}-${sessionId}`;
}

function isRetrySafePreOutputEvent(event: AssistantMessageEvent): boolean {
	return (
		event.type === "start" ||
		event.type === "text_start" ||
		event.type === "thinking_start" ||
		event.type === "toolcall_start"
	);
}

export function createStreamWrapper(
	accountManager: AccountManager,
	baseProvider: ApiProviderRef,
) {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();

		(async () => {
			try {
				await accountManager.waitUntilReady();
				const excludedEmails = new Set<string>();
				for (let attempt = 0; attempt <= MAX_ROTATION_RETRIES; attempt++) {
					const now = Date.now();
					const manual = accountManager.getAvailableManualAccount({
						excludeEmails: excludedEmails,
						now,
					});
					const usingManual = Boolean(manual);
					let account = manual;
					if (!account) {
						if (accountManager.hasManualAccount()) {
							accountManager.clearManualAccount();
						}
						account = await accountManager.activateBestAccount({
							excludeEmails: excludedEmails,
							signal: options?.signal,
						});
					}
					if (!account) {
						throw new Error(
							"No available Multicodex accounts. Please use /multicodex use <identifier>.",
						);
					}

					let token: string;
					try {
						token = await accountManager.ensureValidToken(account);
					} catch (error) {
						accountManager.notifyRotationSkipForAuthFailure(account, error);
						if (usingManual) {
							accountManager.clearManualAccount();
						}
						excludedEmails.add(account.email);
						if (attempt < MAX_ROTATION_RETRIES) {
							continue;
						}
						throw error;
					}
					accountManager.setRuntimeActiveAccount?.(account.email);
					const abortController = createLinkedAbortController(options?.signal);

					const internalModel: Model<"openai-codex-responses"> = {
						...(model as Model<"openai-codex-responses">),
						provider: "openai-codex",
						api: "openai-codex-responses",
					};

					const inner = baseProvider.streamSimple(
						{
							...internalModel,
							headers: {
								...(internalModel.headers || {}),
								"X-Multicodex-Account": account.email,
							},
						},
						context,
						{
							...options,
							apiKey: token,
							signal: abortController.signal,
							// Each attempt authenticates independently, including shared-workspace accounts.
							// Keep the requested transport but never reuse another credential's socket.
							...(options?.transport === "sse"
								? {
										sessionId: accountScopedSessionId(
											options.sessionId,
											account.email,
										),
									}
								: { cacheRetention: "none" as const }),
						},
					);

					let outputStarted = false;
					const bufferedPreOutputEvents: AssistantMessageEvent[] = [];
					let retry = false;
					const flushBufferedPreOutputEvents = () => {
						for (const bufferedEvent of bufferedPreOutputEvents) {
							stream.push(
								rewriteProviderOnEvent(bufferedEvent, model.provider),
							);
						}
						bufferedPreOutputEvents.length = 0;
					};
					const rotateAfterQuota = async (quotaError: unknown) => {
						try {
							await accountManager.handleQuotaExceeded(account, {
								quotaError,
								signal: options?.signal,
							});
						} catch (error) {
							if (!isQuotaErrorMessage(normalizeUnknownError(error))) {
								throw error;
							}
						}
						if (usingManual) {
							accountManager.clearManualAccount();
						}
						excludedEmails.add(account.email);
						abortController.abort();
						retry = true;
					};

					try {
						for await (const event of inner) {
							if (!outputStarted && isRetrySafePreOutputEvent(event)) {
								bufferedPreOutputEvents.push(event);
								continue;
							}

							if (event.type === "error") {
								const msg = event.error.errorMessage || "";
								const isQuota = isQuotaErrorMessage(msg);

								if (
									isQuota &&
									!outputStarted &&
									attempt < MAX_ROTATION_RETRIES
								) {
									await rotateAfterQuota(event.error);
									break;
								}

								flushBufferedPreOutputEvents();
								stream.push(rewriteProviderOnEvent(event, model.provider));
								stream.end();
								return;
							}

							flushBufferedPreOutputEvents();
							if (event.type !== "done") {
								outputStarted = true;
							}
							stream.push(rewriteProviderOnEvent(event, model.provider));

							if (event.type === "done") {
								stream.end();
								return;
							}
						}
					} catch (error) {
						const isQuota = isQuotaErrorMessage(normalizeUnknownError(error));

						if (isQuota && !outputStarted && attempt < MAX_ROTATION_RETRIES) {
							await rotateAfterQuota(error);
						} else {
							flushBufferedPreOutputEvents();
							throw error;
						}
					}

					if (retry) {
						continue;
					}

					stream.end();
					return;
				}
			} catch (error) {
				const message = normalizeUnknownError(error);
				const errorEvent: AssistantMessageEvent = {
					type: "error",
					reason: "error",
					error: createErrorAssistantMessage(
						model,
						`Multicodex failed: ${message}`,
					),
				};
				stream.push(rewriteProviderOnEvent(errorEvent, model.provider));
				stream.end();
			}
		})();

		return stream;
	};
}
