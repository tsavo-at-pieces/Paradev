import type { AppRouter as HostRouter } from "@superset/host-service";
import { SUPERSET_USER_ID_HEADER } from "@superset/shared/host-routing";
import { createTRPCClient, httpLink } from "@trpc/client";
import { decodeJwt } from "jose";
import { getHostServiceCoordinator } from "main/lib/host-service-coordinator";
import { getSubmissionIssuer } from "main/lib/submission-provenance";
import { getEntry, getOrg } from "main/lib/window-registry/window-registry";
import superjson from "superjson";
import { publicProcedure, router } from "../..";
import type { TrpcContext } from "../../context";
import { loadToken } from "../auth/utils/auth-functions";
import {
	localSubmissionHostUrl,
	matchesSubmissionHost,
	requireSubmissionWindow,
} from "./access";
import { createSubmissionHandlers } from "./handlers";
import { runSubmissionSchema, sendSubmissionSchema } from "./schema";

async function getSubmissionTarget(ctx: TrpcContext, hostUrl: string) {
	const window = requireSubmissionWindow(
		ctx.senderWindow,
		ctx.senderIsMainFrame,
		(id) => getEntry(id)?.window,
	);
	const orgId = getOrg(window.id);
	if (!orgId) return null;
	const connection = getHostServiceCoordinator().getConnection(orgId);
	if (!connection || !matchesSubmissionHost(hostUrl, connection.port)) {
		return null;
	}
	const issuer = await getSubmissionIssuer().catch(() => null);
	if (!issuer) return null;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${connection.secret}`,
		"x-superset-client-machine-id": connection.machineId,
	};
	const auth = await loadToken().catch(() => null);
	if (!auth) return null;
	if (auth.token) {
		try {
			const subject = decodeJwt(auth.token).sub;
			if (subject) headers[SUPERSET_USER_ID_HEADER] = subject;
		} catch {
			return null;
		}
	}
	const client = createTRPCClient<HostRouter>({
		links: [
			httpLink({
				url: `${localSubmissionHostUrl(connection.port)}/trpc`,
				transformer: superjson,
				headers,
			}),
		],
	});
	return { issuer, client, hostId: connection.machineId };
}

export const createSubmissionProvenanceRouter = () => {
	const handlers = createSubmissionHandlers(getSubmissionTarget);
	const submissionProcedure = publicProcedure.use(({ ctx, next }) => {
		requireSubmissionWindow(
			ctx.senderWindow,
			ctx.senderIsMainFrame,
			(id) => getEntry(id)?.window,
		);
		return next();
	});
	return router({
		run: submissionProcedure
			.input(runSubmissionSchema)
			.mutation(({ ctx, input }) => handlers.run(ctx, input)),
		send: submissionProcedure
			.input(sendSubmissionSchema)
			.mutation(({ ctx, input }) => handlers.send(ctx, input)),
	});
};
