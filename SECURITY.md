# Security

Cindl handles access to a personal agent that can act on its owner's behalf.
Please report vulnerabilities privately through GitHub's **Report a
vulnerability** button on this repository (Security tab), not in public issues.
Do not include real tokens, hostnames or personal data in a report; synthetic
reproductions are enough.

The threat model, trust boundaries and mitigations are documented in
[`docs/handbook/security/threat-model.md`](docs/handbook/security/threat-model.md).

## What is in scope

- Token handling on each client (Electron main process, Android Keystore, web
  same-origin cookie).
- The Electron IPC boundary and renderer isolation.
- Rendering of untrusted agent output (Markdown, links, images).
- Approval and clarification answers (answer-once, offered choices only).
- Owner edits to SOUL.md and skills (diff, confirmation, version checks).
- Agent-computer viewing and control leases.

## What Cindl does not claim

- It does not revoke Hermes tokens remotely: Hermes v0.22.5's native tokens are
  stateless, so signing out is local to a device.
- Command approvals are Hermes's dangerous-command gate, not a universal policy
  engine for every action the agent can take.
- Hermes v0.22.5 has no server-side compare-and-swap for SOUL.md or skills;
  Cindl detects conflicts by re-reading, which narrows but cannot close a race.
