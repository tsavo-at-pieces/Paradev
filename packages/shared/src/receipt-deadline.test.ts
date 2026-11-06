import { expect, test } from "bun:test";
import { type ReceiptClock, withReceiptDeadline } from "./receipt-deadline";

test("never-resolving receipt I/O expires on an injected clock and late fulfillment is ignored", async () => {
	let timeout: (() => void) | undefined;
	let finishWork: ((value: string) => void) | undefined;
	const clock: ReceiptClock = {
		setTimeout: (callback) => {
			timeout = callback;
			return 1;
		},
		clearTimeout: () => {},
	};
	const promise = withReceiptDeadline(
		() =>
			new Promise<string>((resolve) => {
				finishWork = resolve;
			}),
		"fallback",
		{ clock, deadlineMs: 3 },
	);
	await Promise.resolve();
	timeout?.();
	expect(await promise).toBe("fallback");
	finishWork?.("late");
	expect(await promise).toBe("fallback");
});
