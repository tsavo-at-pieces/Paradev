import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { z } from "zod";

const identifier = z
	.string()
	.min(1)
	.max(256)
	.refine((value) =>
		[...value].every(
			(char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127,
		),
	);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
	submissionId: identifier,
	provider: z.enum(["claude", "codex"]),
	workspaceId: identifier,
	terminalId: identifier,
	contentHash: digest,
	issuedAt: z
		.string()
		.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/)
		.refine((value) => Number.isFinite(Date.parse(value))),
};
const submissionPayloadSchema = z
	.object({
		...common,
		type: z.literal("submission"),
		actor: z.enum(["owner", "agent", "system"]),
		origin: z.enum(["owner_ui", "agent_api", "hcom", "automation"]),
	})
	.strict();
const bindingPayloadSchema = z
	.object({
		...common,
		type: z.literal("binding"),
		assertionDigest: digest,
		nativeSessionId: identifier,
		agentId: identifier,
		messageId: identifier,
		turnId: identifier.optional(),
		eventKind: z.enum(["input", "tool_result"]),
		questionId: identifier.optional(),
		state: z.enum(["written", "matched"]),
	})
	.strict()
	.refine(
		(value) =>
			value.eventKind !== "tool_result" || value.questionId !== undefined,
	);
const envelope = {
	schemaVersion: z.literal(1),
	issuerId: identifier,
	receiptId: identifier,
};
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
export const submissionAssertionSchema = z
	.object({ ...envelope, payload: submissionPayloadSchema, signature })
	.strict();
export const submissionBindingSchema = z
	.object({ ...envelope, payload: bindingPayloadSchema, signature })
	.strict();
export type SubmissionAssertion = z.infer<typeof submissionAssertionSchema>;
export type SubmissionBinding = z.infer<typeof submissionBindingSchema>;
export type SignedReceipt = SubmissionAssertion | SubmissionBinding;
export const issuerSchema = z
	.object({
		id: identifier,
		publicKey: z.string(),
		enabled: z.boolean().optional(),
		allowedTypes: z.array(z.enum(["submission", "binding", "complete"])),
		allowedActors: z.array(z.enum(["owner", "agent", "system"])).optional(),
		allowedOrigins: z
			.array(z.enum(["owner_ui", "agent_api", "hcom", "automation"]))
			.optional(),
	})
	.strict();
export type ReceiptIssuer = z.infer<typeof issuerSchema>;
const DOMAIN = "teamrouter.transcript.receipt.v1\n";

export function canonicalReceiptJSON(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map(canonicalReceiptJSON).join(",")}]`;
	if (
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw new TypeError("Invalid receipt value");
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalReceiptJSON(record[key])}`)
		.join(",")}}`;
}

type UnsignedReceipt =
	| Omit<SubmissionAssertion, "signature">
	| Omit<SubmissionBinding, "signature">;
function signingBytes(receipt: UnsignedReceipt): Buffer {
	const { schemaVersion, issuerId, receiptId, payload } = receipt;
	return Buffer.from(
		DOMAIN +
			canonicalReceiptJSON({ schemaVersion, issuerId, receiptId, payload }),
	);
}
export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
export function receiptDigest(receipt: UnsignedReceipt): string {
	return createHash("sha256").update(signingBytes(receipt)).digest("hex");
}

export function signTranscriptReceipt<T extends UnsignedReceipt>(
	receipt: T,
	privateKey: KeyObject | string | Buffer,
): T & { signature: string } {
	const schema =
		receipt.payload.type === "submission"
			? submissionAssertionSchema
			: submissionBindingSchema;
	schema.parse({ ...receipt, signature: `${"A".repeat(86)}==` });
	const key =
		typeof privateKey === "string" || Buffer.isBuffer(privateKey)
			? createPrivateKey(privateKey)
			: privateKey;
	if (key.asymmetricKeyType !== "ed25519")
		throw new TypeError("Receipt signing requires Ed25519");
	return {
		...receipt,
		signature: sign(null, signingBytes(receipt), key).toString("base64"),
	};
}

export function verifySignedReceipt(
	value: unknown,
	issuers: ReceiptIssuer[],
): boolean {
	const parsed = z
		.union([submissionAssertionSchema, submissionBindingSchema])
		.safeParse(value);
	if (!parsed.success) return false;
	const receipt = parsed.data;
	const issuer = issuers.find(
		(item) => item.id === receipt.issuerId && item.enabled !== false,
	);
	if (!issuer?.allowedTypes.includes(receipt.payload.type)) return false;
	if (receipt.payload.type === "submission") {
		const { actor, origin } = receipt.payload;
		if (
			!issuer.allowedActors?.includes(actor) ||
			!issuer.allowedOrigins?.includes(origin) ||
			(actor === "owner" && origin !== "owner_ui")
		)
			return false;
	}
	try {
		const key = createPublicKey(issuer.publicKey);
		return (
			key.asymmetricKeyType === "ed25519" &&
			verify(
				null,
				signingBytes(receipt),
				key,
				Buffer.from(receipt.signature, "base64"),
			)
		);
	} catch {
		return false;
	}
}
