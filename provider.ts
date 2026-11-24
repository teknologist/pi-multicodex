import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { getApiProvider, getModels } from "@earendil-works/pi-ai/compat";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AccountManager } from "./account-manager";
import type { SessionRotation } from "./session-rotation";
import { createStreamWrapper } from "./stream-wrapper";

export const PROVIDER_ID = "openai-codex";
const CODEX_RESPONSES_API = "openai-codex-responses";
const MULTICODEX_PROVIDER_MARKER = Symbol.for("pi-multicodex.provider");

type ApiProviderRef = {
	streamSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
};

type ProviderRegistration = Pick<ExtensionAPI, "registerProvider">;

let activeMulticodexProvider: ApiProviderRef | undefined;
let activeDelegateProvider: ApiProviderRef | undefined;

export interface ProviderModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

type OpenAICodexModelOverride = Partial<
	Pick<
		ProviderModelDef,
		| "name"
		| "reasoning"
		| "input"
		| "contextWindow"
		| "maxTokens"
		| "headers"
		| "compat"
	>
> & {
	cost?: Partial<ProviderModelDef["cost"]>;
	thinkingLevelMap?: ThinkingLevelMap;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isModelInputArray(value: unknown): value is ProviderModelDef["input"] {
	return (
		Array.isArray(value) &&
		value.every((entry) => entry === "text" || entry === "image")
	);
}

function normalizeStringRecord(
	value: unknown,
): Record<string, string> | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const entries = Object.entries(object).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeThinkingLevelMap(
	value: unknown,
): ThinkingLevelMap | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const entries = Object.entries(object).filter(
		(entry): entry is [string, string | null] =>
			typeof entry[1] === "string" || entry[1] === null,
	);
	return entries.length > 0
		? (Object.fromEntries(entries) as ThinkingLevelMap)
		: undefined;
}

function normalizeCostOverride(
	value: unknown,
): Partial<ProviderModelDef["cost"]> | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const cost: Partial<ProviderModelDef["cost"]> = {};
	if (isFiniteNumber(object.input)) cost.input = object.input;
	if (isFiniteNumber(object.output)) cost.output = object.output;
	if (isFiniteNumber(object.cacheRead)) cost.cacheRead = object.cacheRead;
	if (isFiniteNumber(object.cacheWrite)) cost.cacheWrite = object.cacheWrite;
	return Object.keys(cost).length > 0 ? cost : undefined;
}

function normalizeCompatOverride(
	value: unknown,
): ProviderModelDef["compat"] | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const compat: Record<string, unknown> = {};
	if (typeof object.sendSessionIdHeader === "boolean") {
		compat.sendSessionIdHeader = object.sendSessionIdHeader;
	}
	if (typeof object.supportsLongCacheRetention === "boolean") {
		compat.supportsLongCacheRetention = object.supportsLongCacheRetention;
	}
	return Object.keys(compat).length > 0
		? (compat as ProviderModelDef["compat"])
		: undefined;
}

function normalizeOpenAICodexModelOverride(
	value: unknown,
): OpenAICodexModelOverride | undefined {
	const object = asObject(value);
	if (!object) return undefined;

	const override: OpenAICodexModelOverride = {};
	if (typeof object.name === "string") override.name = object.name;
	if (typeof object.reasoning === "boolean") {
		override.reasoning = object.reasoning;
	}
	const thinkingLevelMap = normalizeThinkingLevelMap(object.thinkingLevelMap);
	if (thinkingLevelMap) override.thinkingLevelMap = thinkingLevelMap;
	if (isModelInputArray(object.input)) override.input = object.input;
	const cost = normalizeCostOverride(object.cost);
	if (cost) override.cost = cost;
	if (isFiniteNumber(object.contextWindow)) {
		override.contextWindow = object.contextWindow;
	}
	if (isFiniteNumber(object.maxTokens)) override.maxTokens = object.maxTokens;
	const headers = normalizeStringRecord(object.headers);
	if (headers) override.headers = headers;
	const compat = normalizeCompatOverride(object.compat);
	if (compat) override.compat = compat;

	return override;
}

/** Strip Pi-supported `//` comments and trailing commas from JSON. */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) =>
			match[0] === '"' ? match : "",
		)
		.replace(
			/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
			(match, tail) => tail ?? (match[0] === '"' ? match : ""),
		);
}

function cloneHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	return headers ? { ...headers } : undefined;
}

function mergeCompat(
	baseCompat: ProviderModelDef["compat"],
	overrideCompat: ProviderModelDef["compat"] | undefined,
): ProviderModelDef["compat"] {
	if (!overrideCompat) {
		return baseCompat;
	}

	const base = asObject(baseCompat) ?? {};
	const override = asObject(overrideCompat) ?? {};
	const merged: Record<string, unknown> = { ...base, ...override };
	if (
		asObject(base.openRouterRouting) ||
		asObject(override.openRouterRouting)
	) {
		merged.openRouterRouting = {
			...asObject(base.openRouterRouting),
			...asObject(override.openRouterRouting),
		};
	}
	if (
		asObject(base.vercelGatewayRouting) ||
		asObject(override.vercelGatewayRouting)
	) {
		merged.vercelGatewayRouting = {
			...asObject(base.vercelGatewayRouting),
			...asObject(override.vercelGatewayRouting),
		};
	}
	return merged as ProviderModelDef["compat"];
}

function readOpenAICodexModelOverrides(): Map<
	string,
	OpenAICodexModelOverride
> {
	const modelsJsonPath = join(getAgentDir(), "models.json");
	if (!existsSync(modelsJsonPath)) {
		return new Map();
	}

	try {
		const parsed = asObject(
			JSON.parse(stripJsonComments(readFileSync(modelsJsonPath, "utf-8"))),
		);
		const providers = asObject(parsed?.providers);
		const openAICodex = asObject(providers?.[PROVIDER_ID]);
		const modelOverrides = asObject(openAICodex?.modelOverrides);
		const overrides = new Map<string, OpenAICodexModelOverride>();
		for (const [modelId, override] of Object.entries(modelOverrides ?? {})) {
			const normalized = normalizeOpenAICodexModelOverride(override);
			if (normalized) {
				overrides.set(modelId, normalized);
			}
		}
		return overrides;
	} catch {
		return new Map();
	}
}

function applyOpenAICodexModelOverride(
	model: ProviderModelDef,
	override: OpenAICodexModelOverride | undefined,
): ProviderModelDef {
	if (!override) {
		return model;
	}

	const result: ProviderModelDef = {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: override.input ? [...override.input] : model.input,
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
				}
			: model.cost,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
	};
	if (override.headers !== undefined) {
		result.headers = {
			...model.headers,
			...override.headers,
		};
	}
	if (override.compat !== undefined) {
		result.compat = mergeCompat(model.compat, override.compat);
	}
	return result;
}

export function getOpenAICodexMirror(): {
	baseUrl: string;
	models: ProviderModelDef[];
} {
	const sourceModels = getModels("openai-codex");
	const firstModel = sourceModels[0];
	if (!firstModel) {
		return { baseUrl: "https://chatgpt.com/backend-api", models: [] };
	}
	const overrides = readOpenAICodexModelOverrides();
	return {
		baseUrl: firstModel.baseUrl ?? "https://chatgpt.com/backend-api",
		models: sourceModels.map((m) =>
			applyOpenAICodexModelOverride(
				Object.assign(
					{
						id: m.id,
						name: m.name,
						reasoning: m.reasoning,
						thinkingLevelMap: m.thinkingLevelMap
							? { ...m.thinkingLevelMap }
							: undefined,
						input: [...m.input],
						cost: { ...m.cost },
						contextWindow: m.contextWindow,
						maxTokens: m.maxTokens,
					},
					m.headers ? { headers: cloneHeaders(m.headers) } : {},
					m.compat ? { compat: mergeCompat(undefined, m.compat) } : {},
				),
				overrides.get(m.id),
			),
		),
	};
}

function getActiveApiKey(accountManager: AccountManager): string {
	const active = accountManager.getActiveAccount();
	if (active && !active.needsReauth) {
		return active.accessToken;
	}
	// Fallback: first available account with a valid token.
	for (const account of accountManager.getAccounts()) {
		if (!account.needsReauth && account.accessToken) {
			return account.accessToken;
		}
	}
	// Fallback placeholder until MultiCodex resolves a usable managed account.
	return "pending-login";
}

function isMulticodexProvider(provider: unknown): boolean {
	return Boolean(
		provider &&
			typeof provider === "object" &&
			(provider === activeMulticodexProvider ||
				(provider as Record<symbol, unknown>)[MULTICODEX_PROVIDER_MARKER]),
	);
}

function getDelegateProvider(): ApiProviderRef {
	const currentProvider = getApiProvider(CODEX_RESPONSES_API) as
		| ApiProviderRef
		| undefined;
	if (!currentProvider) {
		throw new Error(
			"OpenAI Codex provider not available. Please update pi to include openai-codex support.",
		);
	}

	if (isMulticodexProvider(currentProvider)) {
		if (!activeDelegateProvider) {
			throw new Error(
				"Multicodex provider wrapper is active but no Codex delegate provider is available.",
			);
		}
		return activeDelegateProvider;
	}

	return currentProvider;
}

export function buildMulticodexProviderConfig(
	accountManager: AccountManager,
	baseProvider: ApiProviderRef = getDelegateProvider(),
	rotation?: SessionRotation,
) {
	if (!baseProvider) {
		throw new Error(
			"OpenAI Codex provider not available. Please update pi to include openai-codex support.",
		);
	}

	const config = {
		// Leave models and endpoints to Pi; a model list replaces its live catalog.
		apiKey: getActiveApiKey(accountManager),
		api: CODEX_RESPONSES_API,
		streamSimple: createStreamWrapper(accountManager, baseProvider, rotation),
	};

	Object.defineProperty(config, MULTICODEX_PROVIDER_MARKER, {
		value: true,
	});

	return config;
}

export function installMulticodexProviderWrapper(
	pi: ProviderRegistration,
	accountManager: AccountManager,
	rotation?: SessionRotation,
) {
	const delegateProvider = getDelegateProvider();
	const providerConfig = buildMulticodexProviderConfig(
		accountManager,
		delegateProvider,
		rotation,
	);
	pi.registerProvider(PROVIDER_ID, providerConfig);
	activeDelegateProvider = delegateProvider;
	activeMulticodexProvider = providerConfig;
	return providerConfig;
}

export function resetMulticodexProviderWrapperForTest(): void {
	activeMulticodexProvider = undefined;
	activeDelegateProvider = undefined;
}
