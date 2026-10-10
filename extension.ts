import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { AccountManager } from "./account-manager";
import { registerCommands } from "./commands";
import { isStaleExtensionContextError } from "./context-utils";
import { handleNewSessionSwitch, handleSessionStart } from "./hooks";
import { installMulticodexProviderWrapper } from "./provider";
import { createUsageStatusController } from "./status";

export default function multicodexExtension(pi: ExtensionAPI) {
	const accountManager = new AccountManager();
	const statusController = createUsageStatusController(accountManager);
	let lastContext: ExtensionContext | undefined;

	function notifyWarning(
		ctx: ExtensionContext | undefined,
		message: string,
	): void {
		if (!ctx) return;
		try {
			ctx.ui.notify(message, "warning");
		} catch (error) {
			if (isStaleExtensionContextError(error)) {
				if (lastContext === ctx) lastContext = undefined;
				return;
			}
			throw error;
		}
	}

	accountManager.setWarningHandler((message) => {
		notifyWarning(lastContext, message);
	});

	installMulticodexProviderWrapper(pi, accountManager);

	registerCommands(pi, accountManager, statusController);

	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		lastContext = ctx;
		installMulticodexProviderWrapper(pi, accountManager);
		accountManager.resetSessionWarnings();
		if (event.reason === "new") {
			handleNewSessionSwitch(accountManager, (msg) =>
				notifyWarning(lastContext, msg),
			);
		} else {
			handleSessionStart(accountManager, (msg) =>
				notifyWarning(lastContext, msg),
			);
		}
		statusController.startAutoRefresh();
		void (async () => {
			await statusController.loadPreferences(ctx);
			if (lastContext !== ctx) return;
			await statusController.refreshFor(ctx);
		})();
	});

	pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
		lastContext = ctx;
		void statusController.refreshFor(ctx);
	});

	pi.on("model_select", (_event: unknown, ctx: ExtensionContext) => {
		lastContext = ctx;
		statusController.scheduleModelSelectRefresh(ctx);
	});

	pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
		if (lastContext === ctx) {
			lastContext = undefined;
		}
		accountManager.setWarningHandler(undefined);
		statusController.dispose(ctx);
	});
}
