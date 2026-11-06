import { terminalColorsSchema } from "@superset/shared/terminal-colors";
import { z } from "zod";

export const runSubmissionSchema = z
	.object({
		hostUrl: z.string(),
		workspaceId: z.string().uuid(),
		colors: terminalColorsSchema.optional(),
		agent: z.string().min(1),
		prompt: z.string(),
		attachmentIds: z.array(z.string().uuid()).optional(),
		model: z.string().min(1).optional(),
		mode: z.string().min(1).optional(),
		forkSessionId: z.string().min(1).optional(),
	})
	.strict();

export const sendSubmissionSchema = z
	.object({
		hostUrl: z.string(),
		workspaceId: z.string(),
		terminalId: z.string(),
		text: z.string(),
		submit: z.boolean(),
	})
	.strict();
