import { dirname, isAbsolute, join } from "node:path";
import { readPrivateFile } from "@superset/shared/private-jsonl";
import {
	type ReceiptDeadlineOptions,
	withReceiptDeadline,
} from "@superset/shared/receipt-deadline";
import { issuerSchema } from "@superset/shared/transcript-receipts";
import { z } from "zod";
import { type DeliveryInput, HostSubmissionAdapter } from "./adapter";

const configSchema = z
	.object({
		enabled: z.literal(true),
		issuerId: z.string().min(1).max(256),
		privateKeyPath: z.string().refine(isAbsolute),
		trustedIssuers: z.array(issuerSchema),
	})
	.strict();

const adapters = new Map<string, Promise<HostSubmissionAdapter | null>>();
let warned = false;
function reportFailure(): void {
	if (warned) return;
	warned = true;
	console.warn(
		"[submission-provenance] Receipt collection unavailable; delivery continues without a receipt",
	);
}

export async function loadHostSubmissionAdapter(
	directory: string,
): Promise<HostSubmissionAdapter | null> {
	let raw: string;
	try {
		raw = await readPrivateFile(join(directory, "config.json"), 65536);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("enabled" in parsed) ||
		parsed.enabled !== true
	)
		return null;
	const config = configSchema.parse(parsed);
	return new HostSubmissionAdapter({
		directory,
		issuerId: config.issuerId,
		privateKey: await readPrivateFile(config.privateKeyPath, 16384),
		trustedIssuers: config.trustedIssuers,
	});
}

async function getAdapter(): Promise<HostSubmissionAdapter | null> {
	const dbPath = process.env.HOST_DB_PATH;
	if (!dbPath || !isAbsolute(dbPath)) return null;
	const directory = join(dirname(dbPath), "submission-provenance");
	let loading = adapters.get(directory);
	if (!loading) {
		loading = loadHostSubmissionAdapter(directory).catch(() => {
			reportFailure();
			return null;
		});
		adapters.set(directory, loading);
	}
	return loading;
}

const receiptTasks = new Set<Promise<void>>();

export async function flushSubmissionReceiptsForTests(): Promise<void> {
	while (receiptTasks.size) await Promise.all([...receiptTasks]);
}

export async function prepareSubmissionDelivery(
	input: DeliveryInput,
	options: ReceiptDeadlineOptions & {
		resolveAdapter?: () => Promise<Pick<
			HostSubmissionAdapter,
			"prepare"
		> | null>;
	} = {},
): Promise<{ written(): Promise<void>; failed(): Promise<void> } | null> {
	return withReceiptDeadline(
		async () => {
			try {
				const adapter = await (options.resolveAdapter ?? getAdapter)();
				const delivery = await adapter?.prepare(input);
				if (!delivery) return null;
				const run = (work: () => Promise<void>) => {
					const task = withReceiptDeadline(work, undefined, options);
					receiptTasks.add(task);
					void task.finally(() => receiptTasks.delete(task));
					return task;
				};
				return {
					written: () => run(() => delivery.written()),
					failed: () => run(() => delivery.failed()),
				};
			} catch {
				reportFailure();
				return null;
			}
		},
		null,
		options,
	);
}

export async function observePendingSubmissions(
	input: Parameters<HostSubmissionAdapter["observe"]>[0],
): Promise<void> {
	try {
		const adapter = await getAdapter();
		await adapter?.observe(input);
	} catch {
		reportFailure();
	}
}
