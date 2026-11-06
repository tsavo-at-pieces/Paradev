import { TRPCError } from "@trpc/server";

interface SubmissionWindow {
	id: number;
	isDestroyed(): boolean;
}

export function requireSubmissionWindow<T extends SubmissionWindow>(
	window: T | null,
	senderIsMainFrame: boolean | undefined,
	getRegisteredWindow: (id: number) => T | undefined,
): T {
	if (
		!window ||
		senderIsMainFrame !== true ||
		window.isDestroyed() ||
		getRegisteredWindow(window.id) !== window
	) {
		throw new TRPCError({ code: "FORBIDDEN" });
	}
	return window;
}

export function localSubmissionHostUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

export function matchesSubmissionHost(hostUrl: string, port: number): boolean {
	return hostUrl === localSubmissionHostUrl(port);
}
