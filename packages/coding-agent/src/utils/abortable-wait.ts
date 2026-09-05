/** Stop waiting for read-only preflight work without allowing its late result to start a turn. */
export function abortableWait<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("Operation cancelled", "AbortError"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
