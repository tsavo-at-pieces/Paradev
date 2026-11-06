import { describe, expect, test } from "bun:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { createTrpcContext } from "../../context";
import { matchesSubmissionHost, requireSubmissionWindow } from "./access";
import { runSubmissionSchema, sendSubmissionSchema } from "./schema";

describe("submission IPC sender", () => {
	test("requires the registered window's own WebContents and main frame", async () => {
		const mainFrame = {};
		const ownContents = { mainFrame };
		const window = {
			id: 1,
			webContents: ownContents,
			isDestroyed: () => false,
		} as unknown as BrowserWindow;
		const registry = (id: number) => (id === window.id ? window : undefined);
		for (const [sender, senderFrame, allowed] of [
			[ownContents, mainFrame, true],
			[ownContents, {}, false],
			[{ mainFrame }, mainFrame, false],
		] as const) {
			const context = await createTrpcContext(
				{ event: { sender, senderFrame } as IpcMainInvokeEvent },
				() => window,
			);
			const check = () =>
				requireSubmissionWindow(
					context.senderWindow,
					context.senderIsMainFrame,
					registry,
				);
			if (allowed) expect(check()).toBe(window);
			else expect(check).toThrow();
		}
	});

	test("rejects unregistered, closed, and legacy contexts", () => {
		const window = { id: 1, isDestroyed: () => false };
		expect(() =>
			requireSubmissionWindow(window, true, () => undefined),
		).toThrow();
		expect(() =>
			requireSubmissionWindow(window, undefined, () => window),
		).toThrow();
		const closed = { id: 1, isDestroyed: () => true };
		expect(() => requireSubmissionWindow(closed, true, () => closed)).toThrow();
	});

	test("only proxies the exact main-owned local host endpoint", () => {
		expect(matchesSubmissionHost("http://127.0.0.1:4321", 4321)).toBe(true);
		for (const host of [
			"http://127.0.0.1:4322",
			"http://127.0.0.1:4321@attacker.example",
			"http://127.0.0.1:4321/trpc",
			"https://relay.example/hosts/other",
		]) {
			expect(matchesSubmissionHost(host, 4321)).toBe(false);
		}
	});
});

test("structured submission IPC does not accept actor, origin, receipt, or terminal allocation", () => {
	const run = {
		hostUrl: "http://127.0.0.1:4321",
		workspaceId: "0b4b2fc7-5880-41d1-b6eb-a7c3b10f593c",
		agent: "claude",
		prompt: "hello",
	};
	const send = {
		hostUrl: run.hostUrl,
		workspaceId: run.workspaceId,
		terminalId: "terminal",
		text: "hello",
		submit: true,
	};
	expect(runSubmissionSchema.safeParse(run).success).toBe(true);
	expect(sendSubmissionSchema.safeParse(send).success).toBe(true);
	for (const key of [
		"actor",
		"source",
		"origin",
		"userId",
		"submissionAssertion",
	]) {
		expect(
			runSubmissionSchema.safeParse({ ...run, [key]: "forged" }).success,
		).toBe(false);
		expect(
			sendSubmissionSchema.safeParse({ ...send, [key]: "forged" }).success,
		).toBe(false);
	}
	expect(
		runSubmissionSchema.safeParse({ ...run, terminalId: "forged" }).success,
	).toBe(false);
});
