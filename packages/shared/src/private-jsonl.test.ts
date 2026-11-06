import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPrivateJsonl, readPrivateFile } from "./private-jsonl";

test("private JSONL serializes durable records and refuses exposed files and symlinks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "private-receipts-"));
	const path = join(directory, "inbox.jsonl");
	try {
		await Promise.all([
			appendPrivateJsonl(path, { id: 1 }),
			appendPrivateJsonl(path, { id: 2 }),
		]);
		expect(
			(await readPrivateFile(path))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([{ id: 1 }, { id: 2 }]);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await chmod(path, 0o644);
		await expect(appendPrivateJsonl(path, { id: 3 })).rejects.toThrow(
			"private",
		);
		const target = join(directory, "target");
		await writeFile(target, "untouched", { mode: 0o600 });
		const link = join(directory, "link");
		await symlink(target, link);
		await expect(appendPrivateJsonl(link, { id: 4 })).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe("untouched");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"private key reads and inbox writes reject FIFOs without waiting for another process",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "receipt-fifo-"));
		try {
			const fifo = join(directory, "fifo");
			execFileSync("mkfifo", [fifo]);
			await expect(readPrivateFile(fifo)).rejects.toThrow(
				"Invalid receipt file",
			);
			await expect(appendPrivateJsonl(fifo, { id: 1 })).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
