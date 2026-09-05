import type { IncomingMessage } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

/** Carries a client-facing status without turning invalid JSON into a server error. */
export class HttpBodyError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** Keep draining rejected requests so the caller can deliver a complete HTTP error response. */
export function readBodyJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		function fail(error: Error): void {
			if (settled) return;
			settled = true;
			chunks.length = 0;
			reject(error);
		}
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > maxBytes) {
				fail(new HttpBodyError("请求体过大", 413));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					fail(new HttpBodyError("请求体必须是 JSON 对象", 400));
					return;
				}
				settled = true;
				chunks.length = 0;
				resolve(parsed);
			} catch {
				fail(new HttpBodyError("请求体不是合法的 JSON", 400));
			}
		});
		req.on("error", fail);
		req.on("aborted", () => fail(new HttpBodyError("请求已中断", 400)));
	});
}
