export function needsEventResync(
	since: number,
	nextSeq: number,
	oldest: number | undefined,
	epoch: string,
	clientEpoch: string | null,
): boolean {
	return (
		!Number.isSafeInteger(since) ||
		since < -1 ||
		since >= nextSeq ||
		(clientEpoch !== null && clientEpoch !== epoch) ||
		(oldest !== undefined && since < oldest - 1)
	);
}
