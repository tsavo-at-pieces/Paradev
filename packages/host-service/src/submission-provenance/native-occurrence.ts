import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { contentHash } from "@superset/shared/transcript-receipts";

export interface NativeOccurrence {
	provider: "claude" | "codex";
	submissionId?: string;
	nativeSessionId: string;
	agentId: string;
	messageId: string;
	turnId?: string;
	contentHash: string;
	eventKind: "input";
}

export interface TranscriptCursor {
	path: string;
	device: number;
	inode: number;
	offset: number;
}

export async function captureTranscriptCursor(
	path: string,
): Promise<TranscriptCursor> {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Invalid transcript file");
		return { path, device: stat.dev, inode: stat.ino, offset: stat.size };
	} finally {
		await file.close();
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function exactText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || content.length !== 1) return null;
	const block = record(content[0]);
	return block &&
		(block.type === "text" || block.type === "input_text") &&
		typeof block.text === "string"
		? block.text
		: null;
}

function itemOf(entry: Record<string, unknown>, provider: "claude" | "codex") {
	return provider === "claude"
		? record(entry.message)
		: entry.type === "response_item"
			? record(entry.payload)
			: entry;
}

function inheritedOrContext(entry: Record<string, unknown>): boolean {
	const origin = record(entry.origin);
	return (
		entry.isSidechain === true ||
		entry.inherited === true ||
		entry.isSynthetic === true ||
		entry.synthetic === true ||
		entry.isReplay === true ||
		entry.replayed === true ||
		entry.isMeta === true ||
		entry.turnCompanion === true ||
		entry.isCompactSummary === true ||
		Boolean(record(entry.metadata)?.inherited_user_message) ||
		(entry.agentId !== undefined && entry.agentId !== "main") ||
		["plugin", "task-notification", "system", "hook"].includes(
			String(origin?.kind),
		) ||
		entry.promptSource === "system" ||
		["system", "task_notification"].includes(String(entry.turnOrigin))
	);
}

function codexContext(item: Record<string, unknown>): boolean {
	const metadata = record(item.internal_chat_message_metadata_passthrough);
	const items = metadata?.content_item_metadata;
	const kinds = metadata?.content_item_kinds;
	return (
		(Array.isArray(items) &&
			items.some((value) =>
				["harness", "agents_md", "developer", "system", "skill"].includes(
					String(record(record(value)?.provenance)?.type),
				),
			)) ||
		(Array.isArray(kinds) &&
			kinds.some((value) =>
				[
					"agents_md.instructions",
					"environments.environment_context",
					"skills.selected_skill_instructions",
				].includes(String(value)),
			))
	);
}

export function parseNativeOccurrence(
	value: unknown,
	provider: "claude" | "codex",
	nativeSessionId: string,
): NativeOccurrence | null {
	const entry = record(value);
	if (!entry || inheritedOrContext(entry)) return null;
	const item = itemOf(entry, provider);
	if (!item || item.role !== "user" || inheritedOrContext(item)) return null;
	let messageId: string;
	let turnId: unknown;
	if (provider === "claude") {
		if (
			entry.type !== "user" ||
			entry.sessionId !== nativeSessionId ||
			typeof entry.uuid !== "string" ||
			!entry.uuid
		)
			return null;
		messageId = entry.uuid;
		turnId = entry.promptId;
	} else {
		if (
			item.type !== "message" ||
			typeof item.id !== "string" ||
			!item.id ||
			codexContext(item)
		)
			return null;
		messageId = item.id;
		turnId =
			item.turn_id ??
			record(item.internal_chat_message_metadata_passthrough)?.turn_id;
	}
	const text = exactText(item.content);
	if (text === null) return null;
	return {
		provider,
		nativeSessionId,
		agentId: "main",
		messageId,
		...(typeof entry.paradevSubmissionId === "string"
			? { submissionId: entry.paradevSubmissionId }
			: {}),
		...(typeof turnId === "string" && turnId ? { turnId } : {}),
		contentHash: contentHash(text),
		eventKind: "input",
	};
}

function potentialInput(
	entry: Record<string, unknown>,
	provider: "claude" | "codex",
): boolean {
	const item = itemOf(entry, provider);
	if (
		provider === "claude"
			? entry.type !== "user"
			: item?.type !== "message" || item.role !== "user"
	)
		return false;
	const content = item?.content;
	return !(
		Array.isArray(content) &&
		content.length > 0 &&
		content.every((value) => record(value)?.type === "tool_result")
	);
}

const MAX_TRANSCRIPT_READ = 4 * 1024 * 1024;

export async function readNativeOccurrence({
	path,
	provider,
	nativeSessionId,
	submissionId,
	cursor,
	endCursor,
	ordered = false,
	freshNativeSession = false,
}: {
	path: string;
	provider: "claude" | "codex";
	nativeSessionId: string;
	submissionId: string;
	cursor?: TranscriptCursor;
	endCursor?: TranscriptCursor;
	ordered?: boolean;
	freshNativeSession?: boolean;
}): Promise<NativeOccurrence | null> {
	if (ordered && (!endCursor || (!cursor && !freshNativeSession))) return null;
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) return null;
		for (const bound of [cursor, endCursor]) {
			if (
				bound &&
				(bound.path !== path ||
					bound.device !== stat.dev ||
					bound.inode !== stat.ino ||
					!Number.isSafeInteger(bound.offset) ||
					bound.offset < 0 ||
					bound.offset > stat.size)
			)
				return null;
		}
		const offset = cursor?.offset ?? 0;
		const end = endCursor?.offset ?? stat.size;
		if (end < offset || end > MAX_TRANSCRIPT_READ) return null;
		const bytes = Buffer.alloc(end);
		if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length)
			return null;
		if (
			(offset > 0 && bytes[offset - 1] !== 10) ||
			(end > 0 && bytes[end - 1] !== 10)
		)
			return null;
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let position = 0;
		let nativeMetaSeen = provider === "claude";
		let sidechain = false;
		let inheritedBefore: number | undefined;
		let forked = false;
		let turnId: string | undefined;
		const matches: NativeOccurrence[] = [];
		const nativeIds = new Map<string, number>();
		let inputCount = 0;
		for (
			let endOfLine = bytes.indexOf(10);
			endOfLine !== -1;
			endOfLine = bytes.indexOf(10, position)
		) {
			const inWindow = position >= offset;
			let entry: Record<string, unknown> | null;
			try {
				entry = record(
					JSON.parse(decoder.decode(bytes.subarray(position, endOfLine))),
				);
			} catch {
				return null;
			}
			position = endOfLine + 1;
			if (!entry) return null;
			const payload = record(entry.payload);
			if (
				provider === "codex" &&
				!nativeMetaSeen &&
				entry.type !== "session_meta"
			)
				return null;
			if (provider === "codex" && entry.type === "session_meta") {
				if (nativeMetaSeen || payload?.id !== nativeSessionId) return null;
				nativeMetaSeen = true;
				sidechain =
					record(payload.source)?.subagent !== undefined ||
					payload.thread_source === "subagent" ||
					(payload.agent_path !== undefined && payload.agent_path !== "main");
				forked = Boolean(payload.forked_from_id || payload.parent_thread_id);
				if (typeof payload.subagent_history_start_ordinal === "number")
					inheritedBefore = payload.subagent_history_start_ordinal;
			}
			if (provider === "claude") {
				if (
					entry.sessionId !== undefined &&
					entry.sessionId !== nativeSessionId
				)
					return null;
				sidechain ||=
					entry.isSidechain === true ||
					(entry.agentId !== undefined && entry.agentId !== "main");
			}
			if (
				provider === "codex" &&
				(entry.type === "turn_context" ||
					(entry.type === "event_msg" && payload?.type === "task_started")) &&
				typeof payload?.turn_id === "string"
			)
				turnId = payload.turn_id;
			const nativeId =
				provider === "claude" ? entry.uuid : itemOf(entry, provider)?.id;
			if (potentialInput(entry, provider) && typeof nativeId === "string")
				nativeIds.set(nativeId, (nativeIds.get(nativeId) ?? 0) + 1);
			if (!inWindow) continue;
			if (
				ordered &&
				(entry.type === "compacted" ||
					entry.type === "summary" ||
					entry.subtype === "compact_boundary")
			)
				return null;
			if (!potentialInput(entry, provider)) continue;
			inputCount++;
			const inherited =
				inheritedBefore !== undefined &&
				(typeof entry.ordinal !== "number" || entry.ordinal <= inheritedBefore);
			const occurrence =
				!sidechain && !inherited && !(ordered && freshNativeSession && forked)
					? parseNativeOccurrence(entry, provider, nativeSessionId)
					: null;
			if (ordered) {
				if (
					!occurrence ||
					(entry.paradevSubmissionId !== undefined &&
						occurrence.submissionId !== submissionId)
				)
					return null;
				matches.push(
					occurrence.turnId || !turnId ? occurrence : { ...occurrence, turnId },
				);
			} else if (occurrence?.submissionId === submissionId) {
				matches.push(
					occurrence.turnId || !turnId ? occurrence : { ...occurrence, turnId },
				);
			}
		}
		if (!nativeMetaSeen || sidechain || (ordered && inputCount !== 1))
			return null;
		const match = matches.length === 1 ? matches[0] : undefined;
		return match && nativeIds.get(match.messageId) === 1 ? match : null;
	} finally {
		await file.close();
	}
}
