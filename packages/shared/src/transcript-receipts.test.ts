import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
	canonicalReceiptJSON,
	contentHash,
	receiptDigest,
	signTranscriptReceipt,
	verifySignedReceipt,
} from "./transcript-receipts";

const pair = generateKeyPairSync("ed25519");
const issuer = {
	id: "desktop",
	publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
	allowedTypes: ["submission" as const],
	allowedActors: ["owner" as const],
	allowedOrigins: ["owner_ui" as const],
};
export const unsignedFixture = {
	schemaVersion: 1 as const,
	issuerId: "desktop",
	receiptId: "receipt-1",
	payload: {
		type: "submission" as const,
		submissionId: "submission-1",
		provider: "codex" as const,
		workspaceId: "workspace-1",
		terminalId: "terminal-1",
		contentHash: contentHash("hello\n世界"),
		actor: "owner" as const,
		origin: "owner_ui" as const,
		issuedAt: "2026-11-06T20:00:00.000Z",
	},
};
test("signature covers canonical target, origin and digest and requires scoped Ed25519 issuer", () => {
	const signed = signTranscriptReceipt(unsignedFixture, pair.privateKey);
	expect(verifySignedReceipt(signed, [issuer])).toBe(true);
	expect(
		verifySignedReceipt(
			{ ...signed, payload: { ...signed.payload, terminalId: "other" } },
			[issuer],
		),
	).toBe(false);
	expect(
		verifySignedReceipt(signed, [{ ...issuer, allowedTypes: ["binding"] }]),
	).toBe(false);
	expect(
		verifySignedReceipt(signed, [{ ...issuer, allowedOrigins: ["hcom"] }]),
	).toBe(false);
	expect(verifySignedReceipt(signed, [])).toBe(false);
	expect(receiptDigest(signed)).toBe(receiptDigest(unsignedFixture));
	expect(canonicalReceiptJSON({ b: 1, a: { z: 2, a: 3 } })).toBe(
		'{"a":{"a":3,"z":2},"b":1}',
	);
	expect(() => canonicalReceiptJSON({ invalid: undefined })).toThrow();
});
test("binding cannot carry owner claims or omit question identity", () => {
	const { actor: _actor, origin: _origin, ...common } = unsignedFixture.payload;
	const binding = {
		...unsignedFixture,
		payload: {
			...common,
			type: "binding" as const,
			assertionDigest: receiptDigest(unsignedFixture),
			nativeSessionId: "session-1",
			agentId: "main",
			messageId: "message-1",
			eventKind: "tool_result" as const,
			state: "matched" as const,
		},
	};
	expect(() => signTranscriptReceipt(binding, pair.privateKey)).toThrow();
	expect(() =>
		signTranscriptReceipt(
			{
				...binding,
				payload: { ...binding.payload, questionId: "q1", actor: "owner" },
			},
			pair.privateKey,
		),
	).toThrow();
});
