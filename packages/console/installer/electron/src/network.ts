import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	parseWindowsSystemProxy,
	type SystemHttpProxySettings,
} from "@earendil-works/pi-coding-agent";

export { parseWindowsSystemProxy };
export type SystemProxySettings = SystemHttpProxySettings;

/** Populate proxy environment variables without overriding explicit user configuration. */
export function applyConsoleProxySettings(
	readSystemProxy?: () => SystemProxySettings | undefined,
): SystemProxySettings | undefined {
	return applyHttpProxySettings(undefined, readSystemProxy);
}

/** Configure the process-wide fetch implementation used by model APIs and the updater. */
export function configureConsoleNetworking(): void {
	applyConsoleProxySettings();
	configureHttpDispatcher(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
}
