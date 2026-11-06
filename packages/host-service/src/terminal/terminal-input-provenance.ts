const epochs = new Map<string, number | null>();
const exclusiveInputs = new Set<string>();
let nextEpoch = 0;

export function beginTerminalInputProvenance(
	terminalId: string,
	capabilities?: { exclusiveInputTransport: true },
): void {
	if (epochs.has(terminalId)) return;
	epochs.set(terminalId, ++nextEpoch);
	if (capabilities?.exclusiveInputTransport) exclusiveInputs.add(terminalId);
}

export function hasExclusiveInputTransport(terminalId: string): boolean {
	return exclusiveInputs.has(terminalId);
}

export function captureInputEpoch(terminalId: string): number | null {
	return epochs.get(terminalId) ?? null;
}

export function invalidateInputProvenance(terminalId: string): void {
	if (epochs.has(terminalId)) epochs.set(terminalId, null);
}

export function releaseTerminalInputProvenance(terminalId: string): void {
	epochs.delete(terminalId);
	exclusiveInputs.delete(terminalId);
}
