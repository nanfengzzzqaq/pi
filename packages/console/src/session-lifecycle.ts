export interface SessionToDelete {
	readonly isStreaming: boolean;
	abort(): Promise<void>;
	dispose(): void;
}

export interface TrackedSessionPrompt {
	preflight: Promise<boolean>;
	done: Promise<void>;
	controller?: AbortController;
	requestId?: string;
}

/** 删除前等待消息预处理结束，再中止已启动的任务并释放全部会话资源。 */
export async function abortTrackedSessionPrompt(
	session: SessionToDelete,
	activePrompt: TrackedSessionPrompt | null,
): Promise<boolean> {
	let aborted = false;
	if (activePrompt?.controller) {
		activePrompt.controller.abort();
		aborted = true;
	}
	if (activePrompt) {
		await Promise.race([activePrompt.preflight.then(() => undefined), activePrompt.done.catch(() => undefined)]);
	}
	if (session.isStreaming) {
		await session.abort();
		aborted = true;
	}
	await activePrompt?.done.catch(() => undefined);
	return aborted;
}

/** 删除前先收敛当前消息，再释放全部会话资源。 */
export async function disposeSessionBeforeDelete(
	session: SessionToDelete,
	activePrompt: TrackedSessionPrompt | null,
): Promise<boolean> {
	const aborted = await abortTrackedSessionPrompt(session, activePrompt);
	session.dispose();
	return aborted;
}
