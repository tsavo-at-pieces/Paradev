export interface ReceiptClock {
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ReceiptDeadlineOptions {
	deadlineMs?: number;
	clock?: ReceiptClock;
}

const clock: ReceiptClock = {
	setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function withReceiptDeadline<T>(
	work: () => Promise<T>,
	fallback: T,
	options: ReceiptDeadlineOptions = {},
): Promise<T> {
	const timer = options.clock ?? clock;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			timer.clearTimeout(handle);
			resolve(value);
		};
		const handle = timer.setTimeout(
			() => finish(fallback),
			options.deadlineMs ?? 500,
		);
		Promise.resolve()
			.then(work)
			.then(finish, () => finish(fallback));
	});
}
