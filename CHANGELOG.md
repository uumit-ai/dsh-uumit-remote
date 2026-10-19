# Changelog

## 0.1.0-beta.1

- Fix the Web3.0 links in the management panel: the production website for the mainland edition is `https://m.uumit.com`, not `https://uumit.com`. Saved values on `uumit.com` or `www.uumit.com` are mapped to `m.uumit.com` automatically.

## 0.1.0-beta.0

First public preview.

- Connect a `dsh web` instance to UUMit from inside DSH: browser confirmation with a connection code, or an 8-character pairing code.
- Built-in tunnel client (a subset of the frp protocol, with a WSS fallback on port 443); no extra program is downloaded or started.
- Remote access to the full DSH web UI through the app's own URL, with an identity gate that re-checks every request.
- Who can use it: only me, me and people I invite (invite links, grants by phone number, revocation), everyone (with confirmation), or off.
- Management panel inside the DSH page, opened from the sidebar footer; fallback page at `/uumit-remote/`.
- Agent tool `uumit_remote_access` to check status and start connecting.
- Old path-style links (`<address>/s/dsh/`) redirect to the app's own URL.
