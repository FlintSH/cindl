# Threat model

## Assets

- Hermes sessions and tokens (operator-level access to the agent).
- Conversation content, tool arguments and results, SOUL.md, skills, memory
  metadata, routines.
- Control of the agent-owned computer.
- The owner's attention: approvals must not train them to click through.

## Trust boundaries

| Boundary | Trusted side               | Untrusted side                                       |
| -------- | -------------------------- | ---------------------------------------------------- |
| Network  | Hermes host over TLS       | Network path, other hosts                            |
| Electron | Main process               | Renderer (displays agent output), web content        |
| Android  | App process, Keystore      | Other apps, the system browser's pages               |
| Web      | Hermes same-origin session | Other origins, injected content                      |
| Content  | Cindl code                 | Everything Hermes relays from tools, web pages, mail |

## Threats and mitigations

| Threat                                                                    | Mitigation                                                                                                                                                             | Status                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Token theft from renderer or web storage                                  | Tokens only in Electron main (`safeStorage`) or Android secure storage; web uses Hermes's HttpOnly cookie; lint forbids browser storage outside the preferences module | Contract and lint in place; storage implementations pending                           |
| Code interception in native sign-in                                       | PKCE S256, random `state` compared in constant time, loopback IP literal redirects only, single-use code                                                               | Helpers + tests in place; live flow pending                                           |
| Ticket leakage via logs or URLs                                           | Ticket in WS subprotocol, not URL; `redactText` masks tickets, tokens, keys                                                                                            | Implemented and tested                                                                |
| Compromised renderer calls dangerous Hermes methods                       | No passthrough; allowlisted `clientOps`; main re-validates arguments and sender                                                                                        | Contract in place; Electron pending                                                   |
| Prompt-injected agent output exfiltrates data                             | No raw HTML; remote images not fetched without a click; CSP `img-src 'self' data: blob:`; links open externally with destination shown                                 | Implemented in web                                                                    |
| Approval replay or wrong action approved                                  | Answer once by JSON-RPC id on the receiving connection; offered choices only; no standing grants or `all`; replayed frames cannot reopen answered requests             | Contract, reducer and tests in place; live transport pending                          |
| Owner edit clobbers a newer version                                       | `expectedVersion` SHA-256 check before write, diff review, explicit confirmation                                                                                       | Implemented in UI and synthetic scenario; Hermes path pending; race window documented |
| Path traversal / arbitrary file access                                    | No generic filesystem operations in the client surface; memory text unsupported                                                                                        | By design                                                                             |
| Resubmitting a prompt twice after a dropped connection                    | Uncertain submissions are never retried automatically                                                                                                                  | Contract in place; implementation pending                                             |
| Using Hermes's loopback per-process token (readable by any local process) | Cindl supports only login mode (native PKCE or same-origin session); it never fetches or stores that token                                                             | By design                                                                             |
| Secrets typed into chat                                                   | Cindl never asks for credentials; secret/vault/sudo server requests are rejected                                                                                       | By design                                                                             |
| Remote control beyond the agent's screen                                  | Display scope is one profile's agent-owned screen; leases are explicit and server-filtered; viewing never starts a screen                                              | Contract in place; implementation pending                                             |
| Public repository leaks private data                                      | Synthetic fixtures only; `.gitignore` excludes runtime data; privacy review before every push (automated scan pending)                                                 | Manual review now; scanner pending                                                    |
| Supply chain                                                              | Exact versions, one lockfile, pnpm install-script allowlist, minimum release age, pinned CI actions (pending)                                                          | Partly in place                                                                       |

## Out of scope

Compromise of the Hermes host itself, and the owner's own devices' operating
systems. Cindl cannot make Hermes's operator-level session least-privilege.
