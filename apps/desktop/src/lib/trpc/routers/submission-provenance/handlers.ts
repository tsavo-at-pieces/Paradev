import { randomUUID } from "node:crypto";
import type { AppRouter as HostRouter } from "@superset/host-service";
import { sanitizePromptForPty } from "@superset/shared/agent-prompt-launch";
import { withReceiptDeadline } from "@superset/shared/receipt-deadline";
import type { TRPCClient } from "@trpc/client";
import type { getSubmissionIssuer } from "main/lib/submission-provenance";
import type { z } from "zod";
import type { TrpcContext } from "../../context";
import type { runSubmissionSchema, sendSubmissionSchema } from "./schema";

export interface SubmissionTarget {
	issuer: Pick<
		NonNullable<Awaited<ReturnType<typeof getSubmissionIssuer>>>,
		"submit"
	>;
	client: Pick<
		TRPCClient<HostRouter>,
		"settings" | "terminalAgents" | "agents" | "terminal"
	>;
	hostId: string;
}

interface EligibleSubmission {
	target: SubmissionTarget;
	provider: "claude" | "codex";
}

export function createSubmissionHandlers(
	getTarget: (
		ctx: TrpcContext,
		hostUrl: string,
	) => Promise<SubmissionTarget | null>,
	deadlineOptions?: Parameters<typeof withReceiptDeadline>[2],
) {
	return {
		async run(ctx: TrpcContext, input: z.infer<typeof runSubmissionSchema>) {
			if (!input.prompt || input.attachmentIds?.length) {
				return { handled: false as const };
			}
			const eligible = await withReceiptDeadline<EligibleSubmission | null>(
				async () => {
					const target = await getTarget(ctx, input.hostUrl);
					if (!target) return null;
					const configs =
						await target.client.settings.agentConfigs.list.query();
					const config =
						configs.find((entry) => entry.id === input.agent) ??
						configs.find((entry) => entry.presetId === input.agent);
					const provider = config?.presetId;
					if (provider !== "claude" && provider !== "codex") return null;
					return { target, provider };
				},
				null,
				deadlineOptions,
			);
			if (!eligible) return { handled: false as const };
			const { target, provider } = eligible;
			const { hostUrl: _hostUrl, ...launch } = input;
			const terminalId = randomUUID();
			const result = await target.issuer.submit(
				{
					workspaceId: input.workspaceId,
					terminalId,
					provider,
					hostId: target.hostId,
					text: sanitizePromptForPty(input.prompt),
					kind: "initial",
					submit: true,
				},
				(submissionAssertion) =>
					target.client.agents.run.mutate({
						...launch,
						terminalId,
						submissionAssertion,
					}),
			);
			return { handled: true as const, result };
		},
		async send(ctx: TrpcContext, input: z.infer<typeof sendSubmissionSchema>) {
			if (!input.submit || !input.text) return { handled: false as const };
			const eligible = await withReceiptDeadline<EligibleSubmission | null>(
				async () => {
					const target = await getTarget(ctx, input.hostUrl);
					if (!target) return null;
					const bindings =
						await target.client.terminalAgents.listByWorkspace.query({
							workspaceId: input.workspaceId,
						});
					const binding = bindings.find(
						(entry) =>
							entry.terminalId === input.terminalId &&
							entry.endedAt === undefined,
					);
					const provider = binding?.agentId;
					if (provider !== "claude" && provider !== "codex") return null;
					return { target, provider };
				},
				null,
				deadlineOptions,
			);
			if (!eligible) return { handled: false as const };
			const { target, provider } = eligible;
			const text = sanitizePromptForPty(input.text).trimEnd();
			const { hostUrl: _hostUrl, ...message } = input;
			const result = await target.issuer.submit(
				{
					workspaceId: input.workspaceId,
					terminalId: input.terminalId,
					provider,
					hostId: target.hostId,
					text,
					kind: "follow-up",
					submit: true,
				},
				(submissionAssertion) =>
					target.client.terminal.send.mutate({
						...message,
						text,
						submissionAssertion,
					}),
			);
			return { handled: true as const, result };
		},
	};
}
