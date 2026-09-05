import { AuthStorage, type AuthStorageBackend, FileAuthStorageBackend } from "@earendil-works/pi-coding-agent";

function validateAuthContent(content: string | undefined): string | undefined {
	if (content === undefined) return undefined;
	const normalized = content.replace(/^\uFEFF/u, "");
	let value: unknown;
	try {
		value = JSON.parse(normalized);
	} catch {
		throw new Error("账号配置已损坏，已保留原文件，请从备份恢复");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("账号配置格式无效，已保留原文件，请从备份恢复");
	}
	return normalized;
}

/** API-key edits and OAuth share the same file lock and storage implementation. */
export function createConsoleCredentials(path: string) {
	const fileBackend = new FileAuthStorageBackend(path);
	const backend: AuthStorageBackend = {
		withLock(fn) {
			return fileBackend.withLock((current) => fn(validateAuthContent(current)));
		},
		withLockAsync(fn, options) {
			return fileBackend.withLockAsync((current) => fn(validateAuthContent(current)), options);
		},
	};
	const store = AuthStorage.fromStorage(backend);
	return {
		store,
		async apiKeys(): Promise<Record<string, string>> {
			return backend.withLockAsync(async (content) => {
				const data = JSON.parse(content ?? "{}") as Record<string, { type?: string; key?: unknown }>;
				const keys: Record<string, string> = {};
				for (const [provider, credential] of Object.entries(data)) {
					if (credential?.type === "api_key" && typeof credential.key === "string")
						keys[provider] = credential.key;
				}
				return { result: keys };
			});
		},
		async setApiKey(provider: string, key: string): Promise<void> {
			await store.modify(provider, async () => ({ type: "api_key", key }));
		},
		async deleteApiKey(provider: string): Promise<boolean> {
			return backend.withLockAsync(async (content) => {
				const data = JSON.parse(content ?? "{}") as Record<string, { type?: string }>;
				if (data[provider]?.type !== "api_key") return { result: false };
				delete data[provider];
				return { result: true, next: JSON.stringify(data, null, "\t") };
			});
		},
	};
}
