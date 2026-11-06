import { expect, test } from "bun:test";
import type { DeliveryInput } from "./adapter";
import { prepareSubmissionDelivery } from "./index";

test("host receipt preparation times out independently of late adapter I/O", async () => {
	let expire: (() => void) | undefined;
	let finish: ((value: null) => void) | undefined;
	const result = prepareSubmissionDelivery({} as DeliveryInput, {
		deadlineMs: 1,
		clock: {
			setTimeout: (callback) => {
				expire = callback;
				return 1;
			},
			clearTimeout: () => {},
		},
		resolveAdapter: () =>
			new Promise<null>((resolve) => {
				finish = resolve;
			}),
	});
	await Promise.resolve();
	expire?.();
	expect(await result).toBeNull();
	finish?.(null);
	expect(await result).toBeNull();
});
