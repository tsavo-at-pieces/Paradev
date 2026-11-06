import { expect, test } from "bun:test";
import type { SubmissionAssertion } from "@superset/shared/transcript-receipts";
import { createSubmissionHandlers, type SubmissionTarget } from "./handlers";

const context = { senderWindow: null };
const initial = {
	hostUrl: "http://127.0.0.1:4321",
	workspaceId: "workspace",
	agent: "custom-id",
	prompt: "initial prompt",
};
const followUp = {
	hostUrl: initial.hostUrl,
	workspaceId: initial.workspaceId,
	terminalId: "terminal",
	text: "follow-up\n ",
	submit: true,
};

function fixture() {
	const issued: Array<Parameters<SubmissionTarget["issuer"]["submit"]>[0]> = [];
	const launches: Array<Record<string, unknown>> = [];
	const sends: Array<Record<string, unknown>> = [];
	const assertion: SubmissionAssertion = {
		schemaVersion: 1,
		issuerId: "desktop",
		receiptId: "receipt",
		payload: {
			type: "submission",
			submissionId: "submission",
			provider: "codex",
			workspaceId: "workspace",
			terminalId: "terminal",
			contentHash: "0".repeat(64),
			actor: "owner",
			origin: "owner_ui",
			issuedAt: "2026-11-06T00:00:00.000Z",
		},
		signature: `${"A".repeat(86)}==`,
	};
	let available = true;
	let provider = "codex";
	let failSend = false;
	const target: SubmissionTarget = {
		hostId: "host",
		issuer: {
			async submit(input, dispatch) {
				issued.push(input);
				return dispatch(assertion);
			},
		},
		client: {
			settings: {
				agentConfigs: {
					list: {
						query: async () => [{ id: "custom-id", presetId: provider }],
					},
				},
			},
			terminalAgents: {
				listByWorkspace: {
					query: async () => [{ terminalId: "terminal", agentId: provider }],
				},
			},
			agents: {
				run: {
					mutate: async (input: Record<string, unknown>) => {
						launches.push(input);
						return {
							kind: "terminal",
							sessionId: input.terminalId,
							label: "Codex",
						};
					},
				},
			},
			terminal: {
				send: {
					mutate: async (input: Record<string, unknown>) => {
						sends.push(input);
						if (failSend) throw new Error("host send failed");
						return { terminalId: input.terminalId, submitted: input.submit };
					},
				},
			},
		} as unknown as SubmissionTarget["client"],
	};
	return {
		target,
		handlers: createSubmissionHandlers(async () => (available ? target : null)),
		issued,
		launches,
		sends,
		assertion,
		disable: () => {
			available = false;
		},
		unknownProvider: () => {
			provider = "custom";
		},
		failSend: () => {
			failSend = true;
		},
	};
}

test("initial launch binds a main-generated terminal and host-resolved provider", async () => {
	const f = fixture();
	const result = await f.handlers.run(context, initial);
	expect(result.handled).toBe(true);
	expect(f.issued).toHaveLength(1);
	expect(f.issued[0]).toMatchObject({
		provider: "codex",
		kind: "initial",
		text: initial.prompt,
		hostId: "host",
	});
	expect(f.issued[0].terminalId).toMatch(/^[a-f0-9-]{36}$/);
	expect(f.launches).toEqual([
		{
			workspaceId: initial.workspaceId,
			agent: initial.agent,
			prompt: initial.prompt,
			terminalId: f.issued[0].terminalId,
			submissionAssertion: f.assertion,
		},
	]);
});

test("follow-up dispatch carries the signed assertion and exact normalized text", async () => {
	const f = fixture();
	expect((await f.handlers.send(context, followUp)).handled).toBe(true);
	expect(f.issued[0]).toMatchObject({
		provider: "codex",
		terminalId: "terminal",
		kind: "follow-up",
		text: "follow-up",
	});
	expect(f.sends).toEqual([
		{
			workspaceId: followUp.workspaceId,
			terminalId: "terminal",
			text: "follow-up",
			submit: true,
			submissionAssertion: f.assertion,
		},
	]);
});

test("staged drafts and unresolvable launch content never receive assertions", async () => {
	const f = fixture();
	expect(
		await f.handlers.send(context, { ...followUp, submit: false }),
	).toEqual({ handled: false });
	expect(await f.handlers.run(context, { ...initial, prompt: "" })).toEqual({
		handled: false,
	});
	expect(
		await f.handlers.run(context, {
			...initial,
			attachmentIds: ["attachment"],
		}),
	).toEqual({ handled: false });
	f.unknownProvider();
	expect(await f.handlers.run(context, initial)).toEqual({ handled: false });
	expect(await f.handlers.send(context, followUp)).toEqual({ handled: false });
	expect(f.issued).toEqual([]);
	expect(f.launches).toEqual([]);
	expect(f.sends).toEqual([]);
});

test("disabled or nonlocal target leaves legacy dispatch to the caller", async () => {
	const f = fixture();
	f.disable();
	expect(await f.handlers.run(context, initial)).toEqual({ handled: false });
	expect(await f.handlers.send(context, followUp)).toEqual({ handled: false });
	expect(f.issued).toEqual([]);
	expect(f.launches).toEqual([]);
	expect(f.sends).toEqual([]);
});

test("a failed host write propagates and cannot trigger a second legacy send", async () => {
	const f = fixture();
	f.failSend();
	await expect(f.handlers.send(context, followUp)).rejects.toThrow(
		"host send failed",
	);
	expect(f.issued).toHaveLength(1);
	expect(f.sends).toHaveLength(1);
});

function deadlineClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		setTimeout(callback: () => void, ms: number): unknown {
			const id = ++nextId;
			timers.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout(handle: unknown) {
			timers.delete(handle as number);
		},
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of timers) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.callback();
			}
		},
	};
}

test("a target lookup that never settles leaves ordinary send available at the injected deadline", async () => {
	const clock = deadlineClock();
	const handlers = createSubmissionHandlers(() => new Promise(() => {}), {
		deadlineMs: 5,
		clock,
	});
	const run = handlers.run(context, initial);
	const send = handlers.send(context, followUp);
	clock.advance(5);
	expect(await run).toEqual({ handled: false });
	expect(await send).toEqual({ handled: false });
});

test("target and metadata share one deadline and late metadata cannot dispatch after fallback", async () => {
	const f = fixture();
	const clock = deadlineClock();
	const target = Promise.withResolvers<SubmissionTarget | null>();
	const originalQuery = f.target.client.terminalAgents.listByWorkspace.query;
	const metadata =
		Promise.withResolvers<Awaited<ReturnType<typeof originalQuery>>>();
	const queryStarted = Promise.withResolvers<void>();
	f.target.client.terminalAgents.listByWorkspace.query = () => {
		queryStarted.resolve();
		return metadata.promise;
	};
	const handlers = createSubmissionHandlers(() => target.promise, { clock });
	const sending = handlers.send(context, followUp);
	clock.advance(400);
	target.resolve(f.target);
	await queryStarted.promise;
	clock.advance(100);
	let legacySends = 0;
	if (!(await sending).handled) legacySends++;
	expect(legacySends).toBe(1);
	metadata.resolve(await originalQuery({ workspaceId: followUp.workspaceId }));
	await metadata.promise;
	await Promise.resolve();
	await Promise.resolve();
	expect(f.issued).toEqual([]);
	expect(f.sends).toEqual([]);
});

test("the auxiliary deadline never times out or retries an actual host mutation", async () => {
	const f = fixture();
	const clock = deadlineClock();
	const originalSend = f.target.client.terminal.send.mutate;
	const hostResult =
		Promise.withResolvers<Awaited<ReturnType<typeof originalSend>>>();
	const dispatched = Promise.withResolvers<void>();
	f.target.client.terminal.send.mutate = async (input) => {
		await originalSend(input);
		dispatched.resolve();
		return hostResult.promise;
	};
	const handlers = createSubmissionHandlers(async () => f.target, { clock });
	let settled = false;
	const sending = handlers.send(context, followUp).then((result) => {
		settled = true;
		return result;
	});
	await dispatched.promise;
	clock.advance(1000);
	await Promise.resolve();
	expect(settled).toBe(false);
	expect(f.sends).toHaveLength(1);
	hostResult.resolve({ terminalId: followUp.terminalId, submitted: true });
	expect((await sending).handled).toBe(true);
	expect(f.sends).toHaveLength(1);
});
