import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./session-index.ts";

export type RequestStatus = "accepted" | "running" | "completed" | "failed" | "cancelled";
export interface RequestReceipt {
	requestId: string;
	status: RequestStatus;
	fingerprint?: string;
	epoch: string;
	updatedAt: number;
	error?: string;
}

/** A receipt contains no prompt or key. Reusing an ID never executes a second turn. */
export class RequestLedger {
	private readonly directory: string;
	private readonly epoch: string;
	constructor(dataDirectory: string, epoch: string) {
		this.directory = join(dataDirectory, "requests");
		this.epoch = epoch;
	}

	private path(sessionId: string, requestId: string): string {
		if (![sessionId, requestId].every((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id))) {
			throw new Error("请求标识无效");
		}
		return join(this.directory, sessionId, `${requestId}.json`);
	}

	read(sessionId: string, requestId: string): RequestReceipt | undefined {
		const path = this.path(sessionId, requestId);
		if (!existsSync(path)) return undefined;
		const record: RequestReceipt = JSON.parse(readFileSync(path, "utf8"));
		if (
			record.requestId !== requestId ||
			!Object.hasOwn(record, "status") ||
			!["accepted", "running", "completed", "failed", "cancelled"].includes(record.status)
		)
			throw new Error("请求记录损坏，请核对历史记录后再发送");
		if (record.epoch !== this.epoch && ["accepted", "running"].includes(record.status)) {
			return this.write(sessionId, {
				...record,
				status: "failed",
				error: "服务已重启，请核对历史记录。本次请求不会自动重发。",
			});
		}
		return record;
	}

	accept(sessionId: string, requestId: string, payload: unknown): { receipt: RequestReceipt; duplicate: boolean } {
		const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		const existing = this.read(sessionId, requestId);
		if (existing) {
			if (existing.fingerprint && existing.fingerprint !== fingerprint)
				throw new Error("同一请求标识不能用于不同内容");
			return { receipt: existing, duplicate: true };
		}
		return {
			receipt: this.write(sessionId, {
				requestId,
				status: "accepted",
				fingerprint,
				epoch: this.epoch,
				updatedAt: Date.now(),
			}),
			duplicate: false,
		};
	}

	finish(sessionId: string, requestId: string, status: RequestStatus, error?: string): RequestReceipt {
		const previous = this.read(sessionId, requestId);
		return this.write(sessionId, {
			...previous,
			requestId,
			status,
			error,
			epoch: this.epoch,
			updatedAt: Date.now(),
		});
	}

	private write(sessionId: string, record: RequestReceipt): RequestReceipt {
		const next = { ...record, epoch: this.epoch, updatedAt: Date.now() };
		atomicWrite(this.path(sessionId, record.requestId), `${JSON.stringify(next)}\n`);
		return next;
	}

	removeSession(sessionId: string): void {
		this.path(sessionId, "validate");
		rmSync(join(this.directory, sessionId), { recursive: true, force: true });
	}
}
