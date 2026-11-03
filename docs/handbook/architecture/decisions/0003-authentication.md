# 0003 Per-platform authentication

**Status:** Accepted (live validation pending)

**Context.** Hermes v0.22.5 offers cookie sessions via its `/login` page and an
RFC 8252 native flow: `GET /auth/native/authorize` (S256 PKCE + state) →
redirect to a loopback URI → `POST /auth/native/token {code, code_verifier}`
→ `POST /auth/native/refresh {refresh_token, provider?}`. The redirect
validator accepts only `http://127.0.0.1[:port]/…` or `http://[::1][:port]/…`.
Logout does not revoke native tokens (stateless; defaults 12 h access, 30 d
refresh in the basic provider).

**Decision.**

- **Desktop:** the Electron main process runs the PKCE flow with a short-lived
  loopback listener on `127.0.0.1`, stores tokens with `safeStorage`, refreshes
  them, and never exposes them to the renderer. If OS encryption is
  unavailable, tokens are kept in memory only and the UI says so.
- **Android:** the same flow through the system browser and an in-app loopback
  listener; tokens in Keystore-backed secure storage. Backgrounding and process
  death during sign-in must be validated on a real device or emulator before
  Android sign-in is called working.
- **Web:** Hermes's same-origin cookie session; no tokens in browser storage.
- **Sign-out** wipes local tokens and is labelled as local; Cindl never claims
  remote revocation.
- Passwords and 2FA codes are entered only on Hermes's own login pages, never
  in Cindl chat or fields.

**Consequences.** Redirect rules are not relaxed as a workaround. Dashboard
auth is operator-level; Cindl does not pretend to offer least-privilege roles.
