import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

function assertPrivate(
	stat: { mode: number; uid: number },
	directory = false,
): void {
	if (
		(stat.mode & 0o077) !== 0 ||
		(process.getuid && stat.uid !== process.getuid())
	)
		throw new Error(
			`Receipt ${directory ? "directory" : "file"} must be private and owned by this user`,
		);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("Invalid receipt directory");
	assertPrivate(stat, true);
}

export async function readPrivateFile(
	path: string,
	maxBytes = 1024 * 1024,
): Promise<string> {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes)
			throw new Error("Invalid receipt file");
		assertPrivate(stat);
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

const writes = new Map<string, Promise<void>>();
export async function appendPrivateJsonl(
	path: string,
	value: unknown,
): Promise<void> {
	const line = `${JSON.stringify(value)}\n`;
	const previous = writes.get(path) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(async () => {
			await ensurePrivateDirectory(dirname(path));
			const file = await open(
				path,
				constants.O_WRONLY |
					constants.O_APPEND |
					constants.O_CREAT |
					constants.O_NOFOLLOW |
					constants.O_NONBLOCK,
				0o600,
			);
			try {
				const stat = await file.stat();
				if (!stat.isFile()) throw new Error("Invalid receipt inbox");
				assertPrivate(stat);
				await file.writeFile(line, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			const directory = await open(dirname(path), constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		});
	writes.set(path, next);
	try {
		await next;
	} finally {
		if (writes.get(path) === next) writes.delete(path);
	}
}
