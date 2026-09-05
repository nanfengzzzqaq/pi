export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
// JSON can expand one byte into a six-byte Unicode escape. Decode and check the actual file separately.
export const MAX_TEXT_REQUEST_BYTES = MAX_TEXT_FILE_BYTES * 6 + 65536;
export const FILE_LIMITS = {
	attachmentBytes: MAX_ATTACHMENT_BYTES,
	totalAttachmentBytes: MAX_TOTAL_ATTACHMENT_BYTES,
	attachments: 32,
	textFileBytes: MAX_TEXT_FILE_BYTES,
};
