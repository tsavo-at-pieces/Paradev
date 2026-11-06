import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
	appendFile,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contentHash,
	receiptDigest,
	type SubmissionAssertion,
	signTranscriptReceipt,
	verifySignedReceipt,
} from "@superset/shared/transcript-receipts";
import {
	beginTerminalInputProvenance,
	invalidateInputProvenance,
	releaseTerminalInputProvenance,
} from "../terminal/terminal-input-provenance";
import { HostSubmissionAdapter } from "./adapter";
import { loadHostSubmissionAdapter } from "./index";
import {
	parseNativeOccurrence,
	readNativeOccurrence,
} from "./native-occurrence";

const desktop = generateKeyPairSync("ed25519");
const host = generateKeyPairSync("ed25519");
const desktopIssuer = {
	id: "desktop",
	publicKey: desktop.publicKey
		.export({ type: "spki", format: "pem" })
		.toString(),
	allowedTypes: ["submission" as const],
	allowedActors: ["owner" as const],
	allowedOrigins: ["owner_ui" as const],
};
const hostIssuer = {
	id: "host",
	publicKey: host.publicKey.export({ type: "spki", format: "pem" }).toString(),
	allowedTypes: ["binding" as const],
};
const roots: string[] = [];
afterEach(async () => {
	releaseTerminalInputProvenance("terminal");
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paradev-receipts-"));
	roots.push(root);
	const directory = join(root, "receipts");
	const transcriptPath = join(root, "native.jsonl");
	await writeFile(transcriptPath, "");
	const options = {
		directory,
		issuerId: "host",
		privateKey: host.privateKey,
		trustedIssuers: [desktopIssuer],
	};
	const adapter = new HostSubmissionAdapter(options);
	const assertion: SubmissionAssertion = signTranscriptReceipt(
		{
			schemaVersion: 1 as const,
			issuerId: "desktop",
			receiptId: "ui-receipt",
			payload: {
				type: "submission" as const,
				submissionId: "submission",
				provider: "claude" as const,
				workspaceId: "workspace",
				terminalId: "terminal",
				contentHash: contentHash("same text"),
				actor: "owner" as const,
				origin: "owner_ui" as const,
				issuedAt: "2026-11-06T20:00:00.000Z",
			},
		},
		desktop.privateKey,
	);
	const deliveryInput = {
		assertion,
		workspaceId: "workspace",
		terminalId: "terminal",
		prompt: "same text",
		provider: "claude",
		nativeSessionId: "native-session",
		transcriptPath,
	};
	const observation = {
		workspaceId: "workspace",
		terminalId: "terminal",
		provider: "claude",
		nativeSessionId: "native-session",
		transcriptPath,
	};
	const native = (extra = {}) => ({
		type: "user",
		uuid: "message-1",
		sessionId: "native-session",
		paradevSubmissionId: "submission",
		message: { role: "user", content: "same text" },
		...extra,
	});
	return {
		root,
		directory,
		transcriptPath,
		options,
		adapter,
		assertion,
		deliveryInput,
		observation,
		native,
	};
}

describe("host receipt binding", () => {
	test("publishes a separate binding only after written and exact correlated native observation", async () => {
		const f = await fixture();
		const delivery = await f.adapter.prepare(f.deliveryInput);
		await appendFile(f.transcriptPath, `${JSON.stringify(f.native())}\n`);
		await f.adapter.observe(f.observation);
		expect(await Bun.file(join(f.directory, "inbox.jsonl")).exists()).toBe(
			false,
		);
		await delivery?.written();
		await f.adapter.observe(f.observation);
		const [chain] = (await readFile(join(f.directory, "inbox.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(chain.assertion).toEqual(f.assertion);
		expect(verifySignedReceipt(chain.binding, [hostIssuer])).toBe(true);
		expect(chain.binding.payload.assertionDigest).toBe(
			receiptDigest(f.assertion),
		);
		expect(chain.binding.payload.messageId).toBe("message-1");
		expect(chain.binding.payload.actor).toBeUndefined();
		expect((await stat(join(f.directory, "inbox.jsonl"))).mode & 0o777).toBe(
			0o600,
		);
	});

	test("matching raw text and repeated prompts without native submission identity stay pending", async () => {
		const f = await fixture();
		const delivery = await f.adapter.prepare(f.deliveryInput);
		await delivery?.written();
		await appendFile(
			f.transcriptPath,
			`${[
				f.native({ paradevSubmissionId: undefined }),
				f.native({ paradevSubmissionId: undefined, uuid: "message-2" }),
			]
				.map((value) => JSON.stringify(value))
				.join("\n")}\n`,
		);
		await f.adapter.observe(f.observation);
		expect(await Bun.file(join(f.directory, "inbox.jsonl")).exists()).toBe(
			false,
		);
	});

	test("preexisting native occurrences cannot bind a later delivery", async () => {
		const f = await fixture();
		await appendFile(f.transcriptPath, `${JSON.stringify(f.native())}\n`);
		const delivery = await f.adapter.prepare(f.deliveryInput);
		await delivery?.written();
		await f.adapter.observe(f.observation);
		expect(await Bun.file(join(f.directory, "inbox.jsonl")).exists()).toBe(
			false,
		);
	});

	test("untrusted assertions and changed target or content do not prepare", async () => {
		const f = await fixture();
		expect(
			await f.adapter.prepare({
				...f.deliveryInput,
				terminalId: "another-terminal",
			}),
		).toBeNull();
		expect(
			await f.adapter.prepare({ ...f.deliveryInput, prompt: "changed" }),
		).toBeNull();
		expect(
			await f.adapter.prepare({
				...f.deliveryInput,
				assertion: { ...f.assertion, issuerId: "unknown" },
			}),
		).toBeNull();
		expect(await Bun.file(join(f.directory, "pending.jsonl")).exists()).toBe(
			false,
		);
	});

	test("wrong native digest, session and ambiguous duplicate correlation do not publish", async () => {
		const f = await fixture();
		const delivery = await f.adapter.prepare(f.deliveryInput);
		await delivery?.written();
		await appendFile(
			f.transcriptPath,
			`${JSON.stringify(f.native({ message: { role: "user", content: "other" } }))}\n`,
		);
		await f.adapter.observe({
			...f.observation,
			nativeSessionId: "another-session",
		});
		await f.adapter.observe(f.observation);
		expect(await Bun.file(join(f.directory, "inbox.jsonl")).exists()).toBe(
			false,
		);
		await appendFile(f.transcriptPath, `${JSON.stringify(f.native())}\n`);
		await f.adapter.observe(f.observation);
		expect(await Bun.file(join(f.directory, "inbox.jsonl")).exists()).toBe(
			false,
		);
	});

	test("durable pending survives reload and published submissions cannot replay", async () => {
		const f = await fixture();
		const delivery = await f.adapter.prepare(f.deliveryInput);
		await delivery?.written();
		await appendFile(f.transcriptPath, `${JSON.stringify(f.native())}\n`);
		const restarted = new HostSubmissionAdapter(f.options);
		await restarted.observe(f.observation);
		const again = new HostSubmissionAdapter(f.options);
		expect(await again.prepare(f.deliveryInput)).toBeNull();
		await again.observe(f.observation);
		expect(
			(await readFile(join(f.directory, "inbox.jsonl"), "utf8"))
				.trim()
				.split("\n"),
		).toHaveLength(1);
	});

	test("default producer is disabled and creates no files", async () => {
		const f = await fixture();
		expect(await loadHostSubmissionAdapter(f.directory)).toBeNull();
		expect(await Bun.file(join(f.directory, "pending.jsonl")).exists()).toBe(
			false,
		);
	});

	test("native tool results, missing occurrence IDs and inherited records stay unsupported", () => {
		expect(
			parseNativeOccurrence(
				{
					type: "response_item",
					paradevSubmissionId: "s",
					payload: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "hello" }],
					},
				},
				"codex",
				"native",
			),
		).toBeNull();
		expect(
			parseNativeOccurrence(
				{
					type: "user",
					uuid: "m",
					sessionId: "native",
					paradevSubmissionId: "s",
					message: {
						role: "user",
						content: [{ type: "tool_result", content: "yes" }],
					},
				},
				"claude",
				"native",
			),
		).toBeNull();
		expect(
			parseNativeOccurrence(
				{
					type: "user",
					uuid: "m",
					sessionId: "native",
					paradevSubmissionId: "s",
					inherited: true,
					message: { role: "user", content: "hello" },
				},
				"claude",
				"native",
			),
		).toBeNull();
	});
});

async function inboxExists(f: Awaited<ReturnType<typeof fixture>>) {
	return Bun.file(join(f.directory, "inbox.jsonl")).exists();
}
function nextAssertion(
	assertion: SubmissionAssertion,
	suffix: string,
): SubmissionAssertion {
	return signTranscriptReceipt(
		{
			schemaVersion: 1,
			issuerId: assertion.issuerId,
			receiptId: `ui-${suffix}`,
			payload: { ...assertion.payload, submissionId: `submission-${suffix}` },
		},
		desktop.privateKey,
	);
}

test("exclusive transport fixture binds a fresh Claude UUID without custom submission metadata", async () => {
	const f = await fixture();
	beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
	const delivery = await f.adapter.prepare({
		...f.deliveryInput,
		transcriptPath: undefined,
		kind: "initial",
		freshNativeSession: true,
	});
	await delivery?.written();
	await appendFile(
		f.transcriptPath,
		`${JSON.stringify(f.native({ paradevSubmissionId: undefined, parentUuid: null, isSidechain: false, promptId: "native-turn" }))}\n`,
	);
	await f.adapter.observe({
		...f.observation,
		nativeSessionId: "wrong-session",
	});
	expect(await inboxExists(f)).toBe(false);
	await f.adapter.observe(f.observation);
	const chain = JSON.parse(
		(await readFile(join(f.directory, "inbox.jsonl"), "utf8")).trim(),
	);
	expect(chain.binding.payload).toMatchObject({
		nativeSessionId: "native-session",
		messageId: "message-1",
		turnId: "native-turn",
	});
	expect(verifySignedReceipt(chain.binding, [hostIssuer])).toBe(true);
});

test("exclusive followups use authenticated context and separate prewrite windows even for repeated text", async () => {
	const f = await fixture();
	beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
	await f.adapter.observe(f.observation);
	for (const n of [1, 2]) {
		const delivery = await f.adapter.prepare({
			...f.deliveryInput,
			kind: "follow-up",
			assertion: nextAssertion(f.assertion, String(n)),
			transcriptPath: join(f.root, "untrusted-path"),
		});
		expect(delivery).not.toBeNull();
		await delivery?.written();
		await appendFile(
			f.transcriptPath,
			`${JSON.stringify(
				f.native({
					paradevSubmissionId: undefined,
					uuid: `message-${n}`,
					parentUuid: n === 1 ? null : "assistant-1",
					message: {
						role: "user",
						content: [{ type: "text", text: "same text" }],
					},
				}),
			)}\n`,
		);
		await f.adapter.observe(f.observation);
	}
	const chains = (await readFile(join(f.directory, "inbox.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(chains.map((chain) => chain.binding.payload.messageId)).toEqual([
		"message-1",
		"message-2",
	]);
});

test("unverified followup context and unproven initial freshness remain pending", async () => {
	for (const kind of ["follow-up", "initial"] as const) {
		const f = await fixture();
		beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
		const delivery = await f.adapter.prepare({ ...f.deliveryInput, kind });
		await delivery?.written();
		await appendFile(
			f.transcriptPath,
			`${JSON.stringify(f.native({ paradevSubmissionId: undefined }))}\n`,
		);
		await f.adapter.observe(f.observation);
		expect(await inboxExists(f)).toBe(false);
	}
});

test("multiple pending signed submissions cannot claim a unique matching native input", async () => {
	const f = await fixture();
	beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
	await f.adapter.observe(f.observation);
	const first = await f.adapter.prepare({
		...f.deliveryInput,
		kind: "follow-up",
	});
	await first?.written();
	const second = await f.adapter.prepare({
		...f.deliveryInput,
		kind: "follow-up",
		assertion: nextAssertion(f.assertion, "second"),
	});
	await second?.written();
	await appendFile(
		f.transcriptPath,
		`${JSON.stringify(f.native({ paradevSubmissionId: undefined }))}\n`,
	);
	await f.adapter.observe(f.observation);
	expect(await inboxExists(f)).toBe(false);
});

test("interleaved raw input and failed Enter disqualify ordered receipt matching", async () => {
	for (const state of [
		"raw-before-enter",
		"raw-after-enter",
		"failed",
	] as const) {
		releaseTerminalInputProvenance("terminal");
		const f = await fixture();
		beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
		await f.adapter.observe(f.observation);
		const delivery = await f.adapter.prepare({
			...f.deliveryInput,
			kind: "follow-up",
		});
		if (state === "raw-before-enter") invalidateInputProvenance("terminal");
		if (state === "failed") await delivery?.failed();
		await delivery?.written();
		if (state === "raw-after-enter") invalidateInputProvenance("terminal");
		await appendFile(
			f.transcriptPath,
			`${JSON.stringify(f.native({ paradevSubmissionId: undefined }))}\n`,
		);
		await f.adapter.observe(f.observation);
		expect(await inboxExists(f)).toBe(false);
	}
});

test("raw input arriving during async native observation cannot publish an earlier clean snapshot", async () => {
	const f = await fixture();
	beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
	const adapter = new HostSubmissionAdapter({
		...f.options,
		readOccurrence: async (input) => {
			const occurrence = await readNativeOccurrence(input);
			invalidateInputProvenance("terminal");
			return occurrence;
		},
	});
	await adapter.observe(f.observation);
	const delivery = await adapter.prepare({
		...f.deliveryInput,
		kind: "follow-up",
	});
	await delivery?.written();
	await appendFile(
		f.transcriptPath,
		`${JSON.stringify(f.native({ paradevSubmissionId: undefined }))}\n`,
	);
	await adapter.observe(f.observation);
	expect(await inboxExists(f)).toBe(false);
});

test("unbound ordered submissions lose eligibility across host process restart", async () => {
	const f = await fixture();
	beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
	await f.adapter.observe(f.observation);
	const delivery = await f.adapter.prepare({
		...f.deliveryInput,
		kind: "follow-up",
	});
	await delivery?.written();
	await appendFile(
		f.transcriptPath,
		`${JSON.stringify(f.native({ paradevSubmissionId: undefined }))}\n`,
	);
	await new HostSubmissionAdapter(f.options).observe(f.observation);
	expect(await inboxExists(f)).toBe(false);
});

test("an alternate PTY writer outside Paradev epochs prevents ordered verification", async () => {
	const f = await fixture();
	beginTerminalInputProvenance("terminal");
	await f.adapter.observe(f.observation);
	const delivery = await f.adapter.prepare({
		...f.deliveryInput,
		kind: "follow-up",
	});
	await delivery?.written();
	await appendFile(
		f.transcriptPath,
		`${JSON.stringify(f.native({ paradevSubmissionId: undefined }))}\n`,
	);
	await f.adapter.observe(f.observation);
	expect(await inboxExists(f)).toBe(false);
});

test("queued initial shell input also requires proven exclusive transport", async () => {
	const f = await fixture();
	beginTerminalInputProvenance("terminal");
	const delivery = await f.adapter.prepare({
		...f.deliveryInput,
		kind: "initial",
		freshNativeSession: true,
		transcriptPath: undefined,
	});
	await delivery?.written();
	await appendFile(
		f.transcriptPath,
		`${JSON.stringify(f.native({ paradevSubmissionId: undefined }))}\n`,
	);
	await f.adapter.observe(f.observation);
	expect(await inboxExists(f)).toBe(false);
});
