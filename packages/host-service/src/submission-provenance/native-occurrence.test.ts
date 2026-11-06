import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@superset/shared/transcript-receipts";
import {
	captureTranscriptCursor,
	parseNativeOccurrence,
	readNativeOccurrence,
} from "./native-occurrence";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

const claudeInput = (extra: Record<string, unknown> = {}) => ({
	type: "user",
	uuid: "native-user-1",
	sessionId: "session",
	isSidechain: false,
	message: { role: "user", content: "repeatable text" },
	...extra,
});
const row = (value: unknown) => `${JSON.stringify(value)}\n`;
async function fixture(initial = "") {
	const root = await mkdtemp(join(tmpdir(), "paradev-native-occurrence-"));
	roots.push(root);
	const path = join(root, "native.jsonl");
	await writeFile(path, initial);
	return {
		root,
		path,
		input: {
			path,
			provider: "claude" as const,
			nativeSessionId: "session",
			submissionId: "submission",
		},
	};
}

describe("ordered native occurrence evidence", () => {
	test("binds a stock Claude UUID in a frozen window without custom metadata", async () => {
		const f = await fixture(
			row(claudeInput({ uuid: "older-identical-input" })),
		);
		const cursor = await captureTranscriptCursor(f.path);
		await appendFile(f.path, row(claudeInput({ promptId: "native-turn" })));
		const endCursor = await captureTranscriptCursor(f.path);
		await appendFile(
			f.path,
			row(claudeInput({ uuid: "later-identical-input" })),
		);
		const occurrence = await readNativeOccurrence({
			...f.input,
			cursor,
			endCursor,
			ordered: true,
		});
		expect(occurrence).toEqual({
			provider: "claude",
			nativeSessionId: "session",
			agentId: "main",
			messageId: "native-user-1",
			turnId: "native-turn",
			contentHash: contentHash("repeatable text"),
			eventKind: "input",
		});
	});

	test("initial matching requires fresh session evidence and tolerates ordinary progress and tool results", async () => {
		const f = await fixture(
			row({
				type: "system",
				subtype: "stop_hook_summary",
				sessionId: "session",
			}) +
				row(claudeInput()) +
				row(
					claudeInput({
						uuid: "result",
						message: {
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "tool", content: "output" },
							],
						},
					}),
				),
		);
		const endCursor = await captureTranscriptCursor(f.path);
		expect(
			await readNativeOccurrence({ ...f.input, ordered: true, endCursor }),
		).toBeNull();
		expect(
			(
				await readNativeOccurrence({
					...f.input,
					ordered: true,
					endCursor,
					freshNativeSession: true,
				})
			)?.messageId,
		).toBe("native-user-1");
		expect(
			await readNativeOccurrence({
				...f.input,
				ordered: true,
				freshNativeSession: true,
			}),
		).toBeNull();
	});

	test("two original inputs are ambiguous even with different text or matching first content", async () => {
		const f = await fixture(
			row(claudeInput()) +
				row(
					claudeInput({
						uuid: "second",
						message: { role: "user", content: "different text" },
					}),
				),
		);
		expect(
			await readNativeOccurrence({
				...f.input,
				ordered: true,
				freshNativeSession: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
	});

	test("malformed records and a partially written last row cannot prove a unique occurrence", async () => {
		const f = await fixture(`${row(claudeInput())}{"type":"user"`);
		expect(
			await readNativeOccurrence({
				...f.input,
				ordered: true,
				freshNativeSession: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
		await writeFile(f.path, `${row(claudeInput())}invalid\n`);
		expect(
			await readNativeOccurrence({
				...f.input,
				ordered: true,
				freshNativeSession: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
	});

	test("native provenance rejects inherited, sidechain, harness context and compact summaries", () => {
		for (const extra of [
			{ inherited: true },
			{ isSynthetic: true },
			{ isReplay: true },
			{ metadata: { inherited_user_message: true } },
			{ isSidechain: true },
			{ isMeta: true },
			{ turnCompanion: true },
			{ isCompactSummary: true },
			{ agentId: "child" },
			{ promptSource: "system" },
			{ origin: { kind: "hook" } },
			{ turnOrigin: "task_notification" },
			{ sessionId: "another-session" },
			{ uuid: undefined },
		])
			expect(
				parseNativeOccurrence(claudeInput(extra), "claude", "session"),
			).toBeNull();
	});

	test("sidechain history, compact boundaries and mixed input blocks invalidate ordered proof", async () => {
		const f = await fixture(
			row({ type: "assistant", sessionId: "session", isSidechain: true }),
		);
		const cursor = await captureTranscriptCursor(f.path);
		await appendFile(f.path, row(claudeInput()));
		expect(
			await readNativeOccurrence({
				...f.input,
				cursor,
				ordered: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
		await writeFile(
			f.path,
			row({ type: "system", subtype: "compact_boundary" }) + row(claudeInput()),
		);
		expect(
			await readNativeOccurrence({
				...f.input,
				ordered: true,
				freshNativeSession: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
		await writeFile(
			f.path,
			row(
				claudeInput({
					message: {
						role: "user",
						content: [
							{ type: "tool_result", content: "output" },
							{ type: "text", text: "repeatable text" },
						],
					},
				}),
			),
		);
		expect(
			await readNativeOccurrence({
				...f.input,
				ordered: true,
				freshNativeSession: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
	});

	test("replaced, truncated and mid-record cursors cannot move a binding to another occurrence", async () => {
		const f = await fixture(row(claudeInput({ uuid: "old" })));
		const cursor = await captureTranscriptCursor(f.path);
		await appendFile(f.path, row(claudeInput()));
		const endCursor = await captureTranscriptCursor(f.path);
		expect(
			await readNativeOccurrence({
				...f.input,
				cursor: { ...cursor, offset: cursor.offset - 1 },
				endCursor,
				ordered: true,
			}),
		).toBeNull();
		await rename(f.path, join(f.root, "old.jsonl"));
		await writeFile(f.path, row(claudeInput()));
		expect(
			await readNativeOccurrence({
				...f.input,
				cursor,
				endCursor,
				ordered: true,
			}),
		).toBeNull();
		const replacement = await captureTranscriptCursor(f.path);
		await writeFile(f.path, "");
		expect(
			await readNativeOccurrence({
				...f.input,
				endCursor: replacement,
				ordered: true,
				freshNativeSession: true,
			}),
		).toBeNull();
	});

	test("duplicate native message IDs cannot identify one original occurrence", async () => {
		const f = await fixture(row(claudeInput()));
		const cursor = await captureTranscriptCursor(f.path);
		await appendFile(f.path, row(claudeInput()));
		expect(
			await readNativeOccurrence({
				...f.input,
				cursor,
				ordered: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
	});

	test("explicit submission correlation remains supported and cannot be overridden by ordering", async () => {
		const f = await fixture(
			row(claudeInput({ paradevSubmissionId: "submission" })),
		);
		expect((await readNativeOccurrence(f.input))?.submissionId).toBe(
			"submission",
		);
		await writeFile(f.path, row(claudeInput({ paradevSubmissionId: "other" })));
		expect(
			await readNativeOccurrence({
				...f.input,
				ordered: true,
				freshNativeSession: true,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
	});

	test("Codex uses only actual item IDs and rejects fork and inherited metadata", async () => {
		const meta = {
			type: "session_meta",
			payload: { id: "session", source: "cli" },
		};
		const user = {
			type: "response_item",
			payload: {
				type: "message",
				id: "codex-message",
				role: "user",
				content: [{ type: "input_text", text: "repeatable text" }],
			},
		};
		const f = await fixture(
			row(meta) +
				row({ type: "turn_context", payload: { turn_id: "codex-turn" } }) +
				row(user),
		);
		const input = {
			...f.input,
			provider: "codex" as const,
			ordered: true,
			freshNativeSession: true,
		};
		expect(
			(
				await readNativeOccurrence({
					...input,
					endCursor: await captureTranscriptCursor(f.path),
				})
			)?.turnId,
		).toBe("codex-turn");
		await writeFile(
			f.path,
			row(meta) + row({ ...user, payload: { ...user.payload, id: undefined } }),
		);
		expect(
			await readNativeOccurrence({
				...input,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
		await writeFile(
			f.path,
			row({ ...meta, payload: { ...meta.payload, forked_from_id: "parent" } }) +
				row(user),
		);
		expect(
			await readNativeOccurrence({
				...input,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
		await writeFile(
			f.path,
			row(meta) + row({ ...user, metadata: { inherited_user_message: true } }),
		);
		expect(
			await readNativeOccurrence({
				...input,
				endCursor: await captureTranscriptCursor(f.path),
			}),
		).toBeNull();
	});
});
