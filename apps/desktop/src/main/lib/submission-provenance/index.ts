import { join } from "node:path";
import { SUPERSET_HOME_DIR } from "../app-environment";
import { loadSubmissionIssuer } from "./issuer";

export type { SubmissionInput } from "./issuer";
export { SubmissionIssuer } from "./issuer";

export function getSubmissionIssuer() {
	return loadSubmissionIssuer(
		join(SUPERSET_HOME_DIR, "submission-provenance"),
		() => {
			console.warn(
				"[submission-provenance] Receipt issuer unavailable; submission continues without provenance",
			);
		},
	);
}
