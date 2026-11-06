import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HostSubmissionAdapter } from "../packages/host-service/src/submission-provenance/adapter";
import {
	beginTerminalInputProvenance,
	releaseTerminalInputProvenance,
} from "../packages/host-service/src/terminal/terminal-input-provenance";
import {
	contentHash,
	signTranscriptReceipt,
	verifySignedReceipt,
} from "../packages/shared/src/transcript-receipts";

const verifierPath = process.argv[2];
if (!verifierPath)
	throw new Error(
		"Usage: bun scripts/check-transcript-receipt-interop.ts /path/to/TeamRouter/src/transcript-receipts.js",
	);
const desktop = generateKeyPairSync("ed25519");
const host = generateKeyPairSync("ed25519");
const issuers = [
	{
		id: "desktop",
		publicKey: desktop.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		allowedTypes: ["submission" as const],
		allowedActors: ["owner" as const],
		allowedOrigins: ["owner_ui" as const],
	},
	{
		id: "host",
		publicKey: host.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		allowedTypes: ["binding" as const],
	},
];
const text = "A pasted <hcom> string\n世界";
const assertion = signTranscriptReceipt(
	{
		schemaVersion: 1 as const,
		issuerId: "desktop",
		receiptId: "assertion-1",
		payload: {
			type: "submission" as const,
			submissionId: "submission-1",
			provider: "claude" as const,
			workspaceId: "workspace",
			terminalId: "terminal",
			contentHash: contentHash(text),
			actor: "owner" as const,
			origin: "owner_ui" as const,
			issuedAt: "2026-11-06T20:00:00.000Z",
		},
	},
	desktop.privateKey,
);
const temporary = await mkdtemp(join(tmpdir(), "receipt-interop-"));
let chain: unknown;
try {
	const transcriptPath = join(temporary, "native.jsonl");
	const directory = join(temporary, "receipts");
	const adapter = new HostSubmissionAdapter({
		directory,
		issuerId: "host",
		privateKey: host.privateKey,
		trustedIssuers: issuers,
	});
	beginTerminalInputProvenance("terminal", { exclusiveInputTransport: true });
	const delivery = await adapter.prepare({
		assertion,
		workspaceId: "workspace",
		terminalId: "terminal",
		provider: "claude",
		nativeSessionId: "native-session",
		prompt: text,
		kind: "initial",
		freshNativeSession: true,
	});
	if (!delivery)
		throw new Error("Expected prepared receipt in exclusive transport fixture");
	await delivery.written();
	await writeFile(
		transcriptPath,
		`${JSON.stringify({ type: "user", uuid: "native-message", sessionId: "native-session", parentUuid: null, isSidechain: false, promptId: "native-turn", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
	);
	await adapter.observe({
		workspaceId: "workspace",
		terminalId: "terminal",
		provider: "claude",
		nativeSessionId: "native-session",
		transcriptPath,
	});
	chain = JSON.parse(
		(await readFile(join(directory, "inbox.jsonl"), "utf8")).trim(),
	);
} finally {
	releaseTerminalInputProvenance("terminal");
	await rm(temporary, { recursive: true, force: true });
}
const result = execFileSync(
	"node",
	[
		"--input-type=module",
		"-e",
		`
 import assert from 'node:assert/strict';
 import { readFileSync } from 'node:fs';
 const contract = await import(process.argv[1]);
 const fixture = JSON.parse(readFileSync(0, 'utf8'));
 const { chain, issuers, text, privateKey } = fixture;
 const result = contract.verifyTranscriptReceipt(chain, { issuers });
 assert.equal(result.valid, true);
 assert.equal(contract.receiptDigest(chain.assertion), chain.binding.payload.assertionDigest);
 const event = { kind:'input', text, provider:'claude', nativeSessionId:'native-session', agentId:'main', messageId:'native-message', turnId:'native-turn' };
 assert.equal(contract.matchReceiptOccurrence(result.receipt, event), true);
 assert.equal(contract.matchReceiptOccurrence(result.receipt, { ...event, messageId:'repeated-elsewhere' }), false);
 assert.equal(contract.verifyTranscriptReceipt(chain.assertion, { issuers }).valid, false);
 assert.equal(contract.verifyTranscriptReceipt({ ...chain, binding:{ ...chain.binding, payload:{ ...chain.binding.payload, contentHash:'a'.repeat(64) } } }, { issuers }).valid, false);
 const { signature, ...unsigned } = chain.assertion;
 process.stdout.write(JSON.stringify(contract.signTranscriptReceipt(unsigned, privateKey)));
`,
		pathToFileURL(resolve(verifierPath)).href,
	],
	{
		input: JSON.stringify({
			chain,
			issuers,
			text,
			privateKey: desktop.privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
		}),
		encoding: "utf8",
	},
);
if (!verifySignedReceipt(JSON.parse(result), issuers))
	throw new Error("Node-produced assertion failed Paradev verification");
console.log(
	"PASS: exclusive transport fixture with stock Claude records, TeamRouter Node cross-verification, pending and tamper cases",
);
