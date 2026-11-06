import { expect, test } from "bun:test";
import {
	beginTerminalInputProvenance,
	captureInputEpoch,
	hasExclusiveInputTransport,
	invalidateInputProvenance,
	releaseTerminalInputProvenance,
} from "./terminal-input-provenance";

test("raw input taint survives reinitialization and released epochs cannot be reused", () => {
	const terminalId = crypto.randomUUID();
	expect(captureInputEpoch(terminalId)).toBeNull();
	beginTerminalInputProvenance(terminalId);
	const epoch = captureInputEpoch(terminalId);
	expect(epoch).not.toBeNull();
	invalidateInputProvenance(terminalId);
	beginTerminalInputProvenance(terminalId);
	expect(captureInputEpoch(terminalId)).toBeNull();
	releaseTerminalInputProvenance(terminalId);
	expect(captureInputEpoch(terminalId)).toBeNull();
	beginTerminalInputProvenance(terminalId);
	expect(captureInputEpoch(terminalId)).not.toBe(epoch);
	releaseTerminalInputProvenance(terminalId);
});

test("a clean PTY epoch does not prove exclusive input", () => {
	const terminalId = crypto.randomUUID();
	beginTerminalInputProvenance(terminalId);
	const epochBeforeUnobservedWriter = captureInputEpoch(terminalId);
	const alternateWriter = () => "bytes sent directly to PTY";
	alternateWriter();
	expect(captureInputEpoch(terminalId)).toBe(epochBeforeUnobservedWriter);
	expect(hasExclusiveInputTransport(terminalId)).toBe(false);
	beginTerminalInputProvenance(terminalId, { exclusiveInputTransport: true });
	expect(hasExclusiveInputTransport(terminalId)).toBe(false);
	releaseTerminalInputProvenance(terminalId);
});

test("only an internal exclusive transport capability enables a stand-in", () => {
	const terminalId = crypto.randomUUID();
	beginTerminalInputProvenance(terminalId, { exclusiveInputTransport: true });
	expect(hasExclusiveInputTransport(terminalId)).toBe(true);
	releaseTerminalInputProvenance(terminalId);
	expect(hasExclusiveInputTransport(terminalId)).toBe(false);
});
