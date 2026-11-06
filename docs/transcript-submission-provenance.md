# Structured terminal submission provenance

The optional TeamRouter companion records submission origin for the existing desktop terminal launch and structured follow-up controls. It adds no composer and does not intercept terminal keystrokes. It is disabled unless both desktop and host receipt producers are configured. No configuration or credentials are installed by this change.

Desktop main accepts calls only from the main frame of a registered application's own top-level WebContents. Embedded browser views, guests, unregistered windows and child frames cannot issue assertions. It resolves the local host from the calling window's organization, validates the exact loopback URL, and looks up the provider on that host. The input schemas accept no actor, origin, signing key or caller-supplied receipt. Main fixes the claim to `actor: owner`, `origin: owner_ui`. This describes the structured UI submission boundary; it does not prove human authorship or derive human identity from a user ID. An account subject is forwarded only for existing host authorization/attribution semantics.

Main signs a `submission` assertion with a new submission UUID, the target workspace and terminal, provider, UTC issue time and SHA-256 of the sanitized UTF-8 prompt. It allocates a terminal UUID before initial launch. The host checks that a requested terminal UUID is unused. The signing key remains in desktop main; the renderer, host and launched agents receive only the signed assertion. The host has a separate binding-only key, which is also never copied to a subprocess environment.

## Delivery states and native binding

Desktop `prepared.jsonl` holds signed assertions. Host `pending.jsonl` is a private journal with `prepared`, `written`, `failed`, `bound`, and `published` transitions. `prepared` means the host verified the assertion, target, provider and exact prompt digest before a write. `written` requires the actual Enter write to succeed; initial launch completion is observed in the background. Receipt work never delays the response after the actual input write. Drafts (`submit: false`), failed Enter writes, mismatched targets, forged assertions and legacy clients cannot produce a completed receipt.

A successful terminal write alone does not identify a native message. Authenticated lifecycle notifications trigger native transcript observation. The observer requires the host-issued terminal attribution token, an allowed transcript path, matching session identity and an actual native message UUID. Provenance keeps its own native context from those verified hooks: the public agent-binding store does not establish trusted context.

There are two correlation routes:

- Explicit native `paradevSubmissionId` metadata must equal the pending assertion's submission ID, with exactly one matching occurrence and the exact content hash.
- Ordered correlation parses real Claude-shaped records without custom metadata, but is gated on an independently proven exclusive input transport. For a fresh initial launch it also requires a host-reserved native session UUID and the first original main input. For a follow-up it captures the transcript inode/offset before the write, freezes the end at the authenticated native observation, and accepts exactly one original main input in that window. A unique candidate alone never grants the exclusive-input capability.

**Current production terminals do not have exclusive input ownership.** hcom can inject directly into a CLI PTY outside Paradev's input handlers and counters. All existing PTY sessions therefore report `exclusiveInputTransport: false`, including ordinary and hcom-managed terminals. Initial commands also travel through a shell PTY, so the adapter does not claim immutable direct-argv delivery. Their ordered fallback remains disabled. A separately verified exclusive transport or an independent hcom delivery sequence is required before enabling that path; no public API, configuration field or environment flag can turn it on. Tests use an explicit internal stand-in transport to exercise the ordered matcher. Stock transcripts without explicit correlation remain unknown in the current PTY deployment.

For eligible opted-in fresh stock Claude commands the host reserves a real native UUID using `--session-id`. It excludes resume/fork and custom command/argument configurations that could override session selection. This reservation proves the expected native identity, not exclusive input ownership. The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents this option.

Observed raw input, unsigned writes, drafts and partial failures permanently disqualify ordered matching for that terminal lifetime. The adapter rejects multiple unresolved submissions, multiple original inputs, duplicate IDs, inherited/sidechain/synthetic/compacted input, mismatched digests and partial or replaced transcript windows. It rechecks the live input epoch and submission sequence after asynchronous transcript reads. Pending ordered submissions lose eligibility across a host restart; explicit native correlation can still recover them. Adopted terminals have no clean epoch. It never joins by nearest timestamp, global digest, role labels or shell command reconstruction.

Only after proving an occurrence does the host sign a `binding` envelope and append `{assertion,binding}` to its private `inbox.jsonl`. The binding covers the assertion digest, target, native session/agent/message IDs, optional turn ID, content hash, `eventKind: input`, and `state: matched`. It carries no actor or origin. TeamRouter independently verifies signatures, scopes and the exact occurrence. Prepared assertions and drafts never become accepted receipts. Codex records without a real occurrence ID remain pending; IDs are never invented. Source transcripts are never modified. Ordinary tool results and question answers are not promoted by this adapter.

Validated initial new-launch assertions also export only the nonsecret `TEAMROUTER_SUBMISSION_ID` in that command's environment overlay. The catalog launcher consumes and clears it after recording its private descriptor, as described in paradev-tooling's `docs/transcript-provenance.md`. The ID supplies correlation only, not actor authority. Resume/fork do not inherit a previous assertion as authority for new inputs. No private key, signature, assertion payload or session-wide origin flag is exported.

The host journal retains stable binding receipt IDs across retries, so replay after an interrupted publish is idempotent for the collector. Truncated or corrupt journals stop collection rather than guessing. The pending journal read is capped at 16 MiB and native reads through the frozen endpoint at 4 MiB; exceeding a bound leaves provenance unavailable/pending. Operators must manage retention of these private files. No prompt plaintext is stored in receipt journals.

## Configuration contract

The following are examples only. Key generation, trust enrollment and installation are separate operator actions. Use distinct Ed25519 keys and issuer IDs for desktop and host. Files must be owned by the running user, readable only by that user (0600), with private directories (0700). Symlinked final files are refused. The local installation and same-user filesystem remain the trust boundary.

Desktop reads `$SUPERSET_HOME_DIR/submission-provenance/config.json`:

```json
{
  "enabled": true,
  "issuerId": "paradev-desktop-ui",
  "privateKeyFile": "/private/operator-managed/desktop-ed25519.pem"
}
```

The private desktop assertion journal is alongside that config at `prepared.jsonl`. A missing config or `enabled` other than `true` disables production. Invalid keys, permissions or storage failures preserve the ordinary send operation. Target/config/key/provider lookup, desktop signing/persistence, and host preparation each have a 500 ms auxiliary deadline; the clocks are injectable for tests. These are separate bounded phases, not a deadline on the actual send. Native write timing and errors remain authoritative. Receipt completion runs in the background. Late receipt I/O may finish a private pending record but never dispatches a prompt or triggers a retry. Private files use nonblocking opens and regular-file checks so FIFO paths cannot hang the open call. The loader reads configuration on each attempt; the host adapter caches its configuration for the process lifetime.

Host reads `submission-provenance/config.json` beside its `HOST_DB_PATH` database:

```json
{
  "enabled": true,
  "issuerId": "paradev-host-delivery",
  "privateKeyPath": "/private/operator-managed/host-ed25519.pem",
  "trustedIssuers": [
    {
      "id": "paradev-desktop-ui",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "allowedTypes": ["submission"],
      "allowedActors": ["owner"],
      "allowedOrigins": ["owner_ui"]
    }
  ]
}
```

Configure TeamRouter's `receiptSources` to read the host's absolute `submission-provenance/inbox.jsonl` path. Register the desktop public issuer above and the host public issuer with `allowedTypes: ["binding"]`; a binding-only issuer needs no actor/origin scope. Do not point the collector at either pending journal. See TeamRouter's `docs/transcript-receipts.md` for its collector configuration and trust enrollment contract.

Signing bytes are UTF-8 `teamrouter.transcript.receipt.v1\n` (one actual newline) followed by recursively key-sorted JSON of `{schemaVersion:1,issuerId,receiptId,payload}`. Signature is padded base64 Ed25519. Assertion digest is SHA-256 of those signing bytes. The shared Paradev implementation is separable from transport in `packages/shared/src/transcript-receipts.ts`.

## Compatibility and validation

Host `agents.run` gains optional `terminalId` and `submissionAssertion`; `terminal.send` gains optional `submissionAssertion`. Existing input fields, result shapes and error cases remain unchanged. Invalid optional assertions are ignored. Old hosts strip the additions and produce no binding. Main uses only existing host procedures and does not retry a dispatched mutation. Absent configuration, unsupported provider/host, staged text and attachment-expanded launches use the existing renderer route. Remote hosts and ACP chat panes do not issue receipts in this implementation. Raw `terminal.writeInput` and terminal websocket input are unchanged.

The compatibility inventory treats desktop, CLI and SDK callers as live. Available local desktop tags predate the current support floor, so they cannot establish a complete released-client inventory; no removal or contract tightening depends on that evidence.

Bounded tests cover signatures and scopes, private JSONL persistence, draft and failed-write behavior, issuer failure without duplicate dispatch, main-frame/window/host authorization, legacy fallback, launch terminal collisions, and durable native matching/replay. The interoperability probe uses temporary in-memory keys and an exclusive transport fixture with real Claude-shaped records without custom metadata. It publishes a chain through the host adapter, calls the actual TeamRouter Node verifier, checks exact occurrence and negative cases, and verifies a Node-produced signature back in Paradev:

```sh
bun scripts/check-transcript-receipt-interop.ts /path/to/TeamRouter/src/transcript-receipts.js
```

No live desktop restart, provider launch, key enrollment, production deployment or session cancellation is required by these tests. A live UI/native-provider end-to-end acceptance claim is outside this implementation's demonstrated coverage.
