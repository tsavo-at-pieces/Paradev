import {
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	randomUUID,
} from "node:crypto";
import { join } from "node:path";
import {
	appendPrivateJsonl,
	readPrivateFile,
} from "@superset/shared/private-jsonl";
import {
	contentHash,
	type ReceiptIssuer,
	receiptDigest,
	type SubmissionAssertion,
	type SubmissionBinding,
	signTranscriptReceipt,
	submissionAssertionSchema,
	submissionBindingSchema,
	verifySignedReceipt,
} from "@superset/shared/transcript-receipts";
import {
	captureInputEpoch,
	hasExclusiveInputTransport,
	invalidateInputProvenance,
} from "../terminal/terminal-input-provenance";
import {
	captureTranscriptCursor,
	readNativeOccurrence,
	type TranscriptCursor,
} from "./native-occurrence";

export interface DeliveryInput {
	assertion: SubmissionAssertion;
	workspaceId: string;
	terminalId: string;
	prompt: string;
	provider?: string;
	nativeSessionId?: string;
	transcriptPath?: string;
	kind?: "initial" | "follow-up";
	freshNativeSession?: boolean;
}

interface PendingSubmission {
	state: "prepared" | "written" | "bound" | "published" | "failed";
	assertion: SubmissionAssertion;
	nativeSessionId?: string;
	cursor?: TranscriptCursor;
	binding?: SubmissionBinding;
	kind?: "initial" | "follow-up";
	freshNativeSession?: boolean;
	runtimeId?: string;
	sequence?: number;
	inputEpoch?: number;
	ambiguous?: boolean;
}

export class HostSubmissionAdapter {
	private readonly runtimeId = randomUUID();
	private readonly sequences = new Map<string, number>();
	private readonly nativeContexts = new Map<
		string,
		{ nativeSessionId: string; provider: string; transcriptPath: string }
	>();
	private readonly pending = new Map<string, PendingSubmission>();
	private readonly key: KeyObject;
	private readonly bindingIssuer: ReceiptIssuer;
	private loaded = false;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly pendingPath: string;
	private readonly inboxPath: string;

	constructor(
		private readonly options: {
			directory: string;
			issuerId: string;
			privateKey: string | KeyObject;
			trustedIssuers: ReceiptIssuer[];
			readOccurrence?: typeof readNativeOccurrence;
		},
	) {
		this.key =
			typeof options.privateKey === "string"
				? createPrivateKey(options.privateKey)
				: options.privateKey;
		if (this.key.asymmetricKeyType !== "ed25519")
			throw new Error("Host receipt key must be Ed25519");
		this.bindingIssuer = {
			id: options.issuerId,
			publicKey: createPublicKey(this.key)
				.export({ type: "spki", format: "pem" })
				.toString(),
			allowedTypes: ["binding"],
		};
		this.pendingPath = join(options.directory, "pending.jsonl");
		this.inboxPath = join(options.directory, "inbox.jsonl");
	}

	private serialized<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.catch(() => {}).then(fn);
		this.queue = next;
		return next;
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		let raw: string;
		try {
			raw = await readPrivateFile(this.pendingPath, 16 * 1024 * 1024);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			raw = "";
		}
		if (raw && !raw.endsWith("\n"))
			throw new Error("Incomplete receipt journal");
		for (const line of raw.split("\n")) {
			if (!line) continue;
			const entry = JSON.parse(line) as PendingSubmission;
			if (
				!submissionAssertionSchema.safeParse(entry.assertion).success ||
				!verifySignedReceipt(entry.assertion, this.options.trustedIssuers)
			)
				throw new Error("Invalid pending assertion");
			if (
				!["prepared", "written", "bound", "published", "failed"].includes(
					entry.state,
				)
			)
				throw new Error("Invalid pending state");
			const prior = this.pending.get(entry.assertion.payload.submissionId);
			if (
				prior &&
				receiptDigest(prior.assertion) !== receiptDigest(entry.assertion)
			)
				throw new Error("Conflicting pending assertion");
			if (entry.state === "bound" || entry.state === "published") {
				const parsed = submissionBindingSchema.safeParse(entry.binding);
				if (
					!parsed.success ||
					!verifySignedReceipt(parsed.data, [this.bindingIssuer])
				)
					throw new Error("Invalid pending binding");
				const payload = parsed.data.payload;
				if (
					payload.assertionDigest !== receiptDigest(entry.assertion) ||
					payload.submissionId !== entry.assertion.payload.submissionId ||
					payload.workspaceId !== entry.assertion.payload.workspaceId ||
					payload.terminalId !== entry.assertion.payload.terminalId ||
					payload.provider !== entry.assertion.payload.provider ||
					payload.contentHash !== entry.assertion.payload.contentHash
				)
					throw new Error("Conflicting pending binding");
			}
			this.pending.set(entry.assertion.payload.submissionId, entry);
		}
		this.loaded = true;
	}

	private async save(entry: PendingSubmission): Promise<void> {
		await appendPrivateJsonl(this.pendingPath, entry);
		this.pending.set(entry.assertion.payload.submissionId, entry);
	}

	async prepare(
		input: DeliveryInput,
	): Promise<{ written(): Promise<void>; failed(): Promise<void> } | null> {
		const sequence = (this.sequences.get(input.terminalId) ?? 0) + 1;
		this.sequences.set(input.terminalId, sequence);
		const inputEpoch = captureInputEpoch(input.terminalId);
		return this.serialized(async () => {
			await this.load();
			const assertion = input.assertion;
			if (!verifySignedReceipt(assertion, this.options.trustedIssuers))
				return null;
			const payload = assertion.payload;
			if (
				payload.workspaceId !== input.workspaceId ||
				payload.terminalId !== input.terminalId ||
				payload.provider !== input.provider ||
				payload.contentHash !== contentHash(input.prompt) ||
				this.pending.has(payload.submissionId)
			)
				return null;
			const context = this.nativeContexts.get(input.terminalId);
			const trustedFollowup =
				input.kind === "follow-up" &&
				context?.provider === input.provider &&
				context.nativeSessionId === input.nativeSessionId;
			const transcriptPath = trustedFollowup
				? context.transcriptPath
				: input.kind
					? undefined
					: input.transcriptPath;
			let cursor: TranscriptCursor | undefined;
			if (transcriptPath) {
				try {
					cursor = await captureTranscriptCursor(transcriptPath);
				} catch {
					return null;
				}
			}
			const unresolved = [...this.pending.values()].filter(
				(entry) =>
					entry.assertion.payload.terminalId === input.terminalId &&
					(entry.state === "prepared" || entry.state === "written"),
			);
			for (const entry of unresolved)
				await this.save({ ...entry, ambiguous: true });
			const entry: PendingSubmission = {
				state: "prepared",
				assertion,
				kind: input.kind,
				runtimeId: this.runtimeId,
				sequence,
				...(input.nativeSessionId
					? { nativeSessionId: input.nativeSessionId }
					: {}),
				...(cursor ? { cursor } : {}),
				...(inputEpoch !== null ? { inputEpoch } : {}),
				...(input.kind === "initial" &&
				input.freshNativeSession &&
				input.nativeSessionId
					? { freshNativeSession: true }
					: {}),
				...(unresolved.length ? { ambiguous: true } : {}),
			};
			await this.save(entry);
			return {
				written: () =>
					this.serialized(async () => {
						const current = this.pending.get(payload.submissionId);
						if (current?.state !== "prepared") return;
						const initialEpoch =
							input.kind === "initial"
								? captureInputEpoch(input.terminalId)
								: null;
						await this.save({
							...current,
							state: "written",
							...(initialEpoch !== null ? { inputEpoch: initialEpoch } : {}),
						});
					}),
				failed: () => {
					invalidateInputProvenance(input.terminalId);
					return this.serialized(async () => {
						const current = this.pending.get(payload.submissionId);
						if (current?.state === "prepared")
							await this.save({ ...current, state: "failed" });
					});
				},
			};
		});
	}

	async observe(input: {
		workspaceId: string;
		terminalId: string;
		nativeSessionId: string;
		provider: string;
		transcriptPath: string;
	}): Promise<void> {
		const {
			workspaceId,
			terminalId,
			nativeSessionId,
			provider,
			transcriptPath,
		} = input;
		this.nativeContexts.set(terminalId, {
			nativeSessionId,
			provider,
			transcriptPath,
		});
		const epochAtHook = captureInputEpoch(terminalId);
		const sequenceAtHook = this.sequences.get(terminalId);
		const endCursorPromise = captureTranscriptCursor(transcriptPath).catch(
			() => undefined,
		);
		await this.serialized(async () => {
			await this.load();
			const endCursor = await endCursorPromise;
			if (!endCursor) return;
			for (const entry of this.pending.values()) {
				const payload = entry.assertion.payload;
				if (
					entry.state === "prepared" ||
					entry.state === "published" ||
					entry.state === "failed" ||
					entry.ambiguous ||
					payload.workspaceId !== workspaceId ||
					payload.terminalId !== terminalId ||
					payload.provider !== provider ||
					(entry.nativeSessionId && entry.nativeSessionId !== nativeSessionId)
				)
					continue;
				let bound = entry;
				if (entry.state === "written") {
					const ordered =
						hasExclusiveInputTransport(terminalId) &&
						entry.runtimeId === this.runtimeId &&
						entry.sequence === sequenceAtHook &&
						entry.inputEpoch !== undefined &&
						entry.inputEpoch === epochAtHook &&
						(entry.kind === "initial"
							? entry.freshNativeSession === true
							: entry.kind === "follow-up" && entry.cursor !== undefined);
					if (
						entry.kind &&
						entry.runtimeId === this.runtimeId &&
						entry.inputEpoch !== epochAtHook
					)
						continue;
					const occurrence = await (
						this.options.readOccurrence ?? readNativeOccurrence
					)({
						path: transcriptPath,
						provider: payload.provider,
						nativeSessionId,
						submissionId: payload.submissionId,
						cursor: entry.cursor,
						endCursor,
						ordered,
						freshNativeSession: entry.freshNativeSession,
					});
					if (!occurrence || occurrence.contentHash !== payload.contentHash)
						continue;
					if (
						ordered &&
						(captureInputEpoch(terminalId) !== entry.inputEpoch ||
							this.sequences.get(terminalId) !== sequenceAtHook)
					)
						continue;
					if (
						[...this.pending.values()].some(
							(other) =>
								other.binding?.payload.nativeSessionId ===
									occurrence.nativeSessionId &&
								other.binding.payload.provider === occurrence.provider &&
								other.binding.payload.agentId === occurrence.agentId &&
								other.binding.payload.messageId === occurrence.messageId,
						)
					)
						continue;
					const binding = signTranscriptReceipt(
						{
							schemaVersion: 1 as const,
							issuerId: this.options.issuerId,
							receiptId: randomUUID(),
							payload: {
								type: "binding" as const,
								submissionId: payload.submissionId,
								assertionDigest: receiptDigest(entry.assertion),
								provider: payload.provider,
								workspaceId,
								terminalId,
								nativeSessionId: occurrence.nativeSessionId,
								agentId: occurrence.agentId,
								messageId: occurrence.messageId,
								...(occurrence.turnId ? { turnId: occurrence.turnId } : {}),
								contentHash: occurrence.contentHash,
								eventKind: occurrence.eventKind,
								state: "matched" as const,
								issuedAt: new Date().toISOString(),
							},
						},
						this.key,
					);
					bound = { ...entry, state: "bound", binding };
					await this.save(bound);
				}
				await appendPrivateJsonl(this.inboxPath, {
					assertion: bound.assertion,
					binding: bound.binding,
				});
				await this.save({ ...bound, state: "published" });
			}
		});
	}
}
