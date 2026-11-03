# Security

Cindl handles access to a personal agent that can act on its owner's behalf.
Please do not report vulnerabilities in public issues.

**How to report.** Private vulnerability reporting is not set up for this
repository yet (an owner decision is pending). Until it is, open an issue
titled "Security contact request" with no technical details, and the maintainer
will reply with a private way to send the report. Use synthetic reproductions;
never include real tokens, hostnames or personal data.

The threat model, trust boundaries and mitigations are documented in
[`docs/handbook/security/threat-model.md`](docs/handbook/security/threat-model.md).

## In scope

- Token handling on each client (Electron main process, Android Keystore, web
  same-origin cookie).
- The Electron IPC boundary and renderer isolation.
- Rendering of untrusted agent output (Markdown, links, images).
- Approval and clarification answers (answered once, offered choices only).
- Owner edits to SOUL.md, skills and memory entries (diff, confirmation,
  version checks).
- Agent-computer viewing and control leases.

## What Cindl does not claim

- It does not revoke Hermes tokens remotely: Hermes v0.22.5 has no native revoke
  route, so signing out is local to a device.
- Command approvals are Hermes's dangerous-command gate, not a universal policy
  engine for every action the agent can take.
- Hermes v0.22.5 has no server-side compare-and-swap for SOUL.md or skills.
  Cindl writes carry the version that was read and are rejected when it no
  longer matches; that narrows but cannot close a race with other editors.
- An independent code review is not a security certification. Live sign-in and
  transport have not been validated against a running Hermes yet.
