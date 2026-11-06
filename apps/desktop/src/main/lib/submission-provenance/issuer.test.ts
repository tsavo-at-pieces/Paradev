import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contentHash,
	type SubmissionAssertion,
} from "@superset/shared/transcript-receipts";
import { loadSubmissionIssuer, SubmissionIssuer } from "./issuer";

const pair = generateKeyPairSync("ed25519");
const input = {
	workspaceId: "workspace",
	terminalId: "terminal",
	provider: "codex" as const,
	text: "literal <hcom> pasted text",
	kind: "follow-up" as const,
	submit: true,
};
test("durably prepares fixed UI-origin assertion before dispatch without caller actor authority", async () => {
	const records: SubmissionAssertion[] = [];
	const issuer = new SubmissionIssuer({
		issuerId: "desktop",
		privateKey: pair.privateKey,
		persist: async (record) => {
			records.push(record);
		},
	});
	const result = await issuer.submit(
		{ ...input, ...{ actor: "system", origin: "hcom", userId: "agent-user" } },
		async (assertion) => {
			if (!assertion) throw new Error("Missing submission assertion");
			expect(records).toEqual([assertion]);
			expect(assertion.payload).toMatchObject({
				actor: "owner",
				origin: "owner_ui",
				contentHash: contentHash(input.text),
				terminalId: input.terminalId,
			});
			expect(JSON.stringify(assertion)).not.toContain(input.text);
			return "sent";
		},
	);
	expect(result).toBe("sent");
});
test("drafts and auxiliary failure dispatch once without assertion; delivery failure never retries", async () => {
	let persisted = 0;
	let sends = 0;
	const issuer = new SubmissionIssuer({
		issuerId: "desktop",
		privateKey: pair.privateKey,
		persist: async () => {
			persisted++;
			throw new Error("disk full");
		},
	});
	for (const submit of [false, true])
		await issuer.submit({ ...input, submit }, async (assertion) => {
			sends++;
			expect(assertion).toBeUndefined();
		});
	expect(persisted).toBe(1);
	expect(sends).toBe(2);
	await expect(
		issuer.submit(input, async () => {
			sends++;
			throw new Error("host failed");
		}),
	).rejects.toThrow("host failed");
	expect(sends).toBe(3);
});
test("missing producer configuration is off and creates no credential", async () => {
	const directory = await mkdtemp(join(tmpdir(), "submission-issuer-"));
	try {
		expect(
			await loadSubmissionIssuer(directory, () => {
				throw new Error("unexpected error");
			}),
		).toBeNull();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("receipt deadline dispatches once without waiting for stalled fsync or resending on late completion", async () => {
	let expire: (() => void) | undefined;
	let finish: (() => void) | undefined;
	let dispatches = 0;
	const issuer = new SubmissionIssuer({
		issuerId: "desktop",
		privateKey: pair.privateKey,
		persist: () =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		deadline: {
			deadlineMs: 1,
			clock: {
				setTimeout: (callback) => {
					expire = callback;
					return 1;
				},
				clearTimeout: () => {},
			},
		},
	});
	const sent = issuer.submit(input, async (assertion) => {
		dispatches++;
		expect(assertion).toBeUndefined();
		return "sent";
	});
	await Promise.resolve();
	expire?.();
	expect(await sent).toBe("sent");
	finish?.();
	await Promise.resolve();
	expect(dispatches).toBe(1);
});
