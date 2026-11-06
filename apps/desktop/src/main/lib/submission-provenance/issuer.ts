import { createPrivateKey, type KeyObject, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
	appendPrivateJsonl,
	readPrivateFile,
} from "@superset/shared/private-jsonl";
import {
	type ReceiptDeadlineOptions,
	withReceiptDeadline,
} from "@superset/shared/receipt-deadline";
import {
	contentHash,
	type SubmissionAssertion,
	signTranscriptReceipt,
} from "@superset/shared/transcript-receipts";
import { z } from "zod";

const configSchema = z
	.object({
		enabled: z.literal(true),
		issuerId: z.string().min(1).max(256),
		privateKeyFile: z.string().refine(isAbsolute),
	})
	.strict();

export interface SubmissionInput {
	workspaceId: string;
	terminalId: string;
	provider: "claude" | "codex";
	text: string;
	kind: "initial" | "follow-up";
	submit: boolean;
	hostId?: string;
}

export class SubmissionIssuer {
	constructor(
		private readonly options: {
			issuerId: string;
			privateKey: KeyObject;
			persist: (assertion: SubmissionAssertion) => Promise<void>;
			now?: () => Date;
			id?: () => string;
			onError?: () => void;
			deadline?: ReceiptDeadlineOptions;
		},
	) {
		if (options.privateKey.asymmetricKeyType !== "ed25519")
			throw new TypeError("Receipt signing requires Ed25519");
	}

	async submit<T>(
		input: SubmissionInput,
		dispatch: (assertion?: SubmissionAssertion) => Promise<T>,
	): Promise<T> {
		const assertion = await withReceiptDeadline<
			SubmissionAssertion | undefined
		>(
			async () => {
				if (input.submit && input.text.length > 0) {
					try {
						const id = this.options.id ?? randomUUID;
						const candidate = signTranscriptReceipt(
							{
								schemaVersion: 1 as const,
								issuerId: this.options.issuerId,
								receiptId: id(),
								payload: {
									type: "submission" as const,
									submissionId: id(),
									provider: input.provider,
									workspaceId: input.workspaceId,
									terminalId: input.terminalId,
									contentHash: contentHash(input.text),
									actor: "owner" as const,
									origin: "owner_ui" as const,
									issuedAt: (this.options.now?.() ?? new Date()).toISOString(),
								},
							},
							this.options.privateKey,
						);
						await this.options.persist(candidate);
						return candidate;
					} catch {
						this.options.onError?.();
					}
				}
				return undefined;
			},
			undefined,
			this.options.deadline,
		);
		return dispatch(assertion);
	}
}

export async function loadSubmissionIssuer(
	directory: string,
	onError: () => void,
): Promise<SubmissionIssuer | null> {
	try {
		const raw = JSON.parse(
			await readPrivateFile(join(directory, "config.json"), 16 * 1024),
		);
		if (raw.enabled !== true) return null;
		const config = configSchema.parse(raw);
		const privateKey = createPrivateKey(
			await readPrivateFile(config.privateKeyFile, 16 * 1024),
		);
		return new SubmissionIssuer({
			issuerId: config.issuerId,
			privateKey,
			onError,
			persist: (assertion) =>
				appendPrivateJsonl(join(directory, "prepared.jsonl"), assertion),
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError();
		return null;
	}
}
