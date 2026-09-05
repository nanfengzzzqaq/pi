import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Resolve the pinned adapter from the application, including in the Electron installation. */
export function bundledProviderExtensionPaths(): string[] {
	try {
		return [require.resolve("pi-antigravity")];
	} catch {
		// An incomplete source update must still allow the existing providers to run.
		return [];
	}
}
