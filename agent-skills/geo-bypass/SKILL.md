---
name: geo-bypass
description: Bypass geo-restrictions and TLS/SSL errors when accessing
  blocked or self-signed-cert hosted resources. Use when the user needs to
  access a geo-blocked website, fix SELF_SIGNED_CERT_IN_CHAIN errors in
  package managers (npm, pip, etc.), scrape a site behind regional
  restrictions, or access content unavailable from the current location.
  Covers TLS bypass, browser automation, web archives, proxies, and
  DNS-based approaches.
---

# Geo-Restriction & TLS Bypass

Decision tree for accessing blocked resources. Pick the right approach
based on the error and what you need to do.

## Quick decision

| Error / Need                      | Approach        | Section                           |
| --------------------------------- | --------------- | --------------------------------- |
| `SELF_SIGNED_CERT_IN_CHAIN` (npm) | TLS bypass      | [TLS bypass](#tls-bypass)         |
| `SELF_SIGNED_CERT_IN_CHAIN` (pip) | TLS bypass      | [TLS bypass](#tls-bypass)         |
| Geo-blocked website (scrape)      | agent-browser   | [Browser access](#browser-access) |
| Geo-blocked website (read)        | web.archive.org | [Archive access](#archive-access) |
| Geo-blocked API                   | Proxy           | [Proxy](#proxy)                   |
| All of the above                  | VPN             | [VPN](#vpn)                       |

## TLS bypass

For package managers hitting private registries with self-signed or
corporate CA certificates.

### npm

**Quickest (insecure):** disable TLS validation entirely.

```bash
npm ci --strict-ssl=false
```

**Persistent (insecure):** set in config, survives across sessions.

```bash
npm config set strict-ssl false
npm ci  # no flags needed
```

**Proper (secure):** trust the specific CA without disabling validation.

1. Extract the root CA from the server's chain:

```bash
# Save the full chain, then extract the last cert (self-signed root)
openssl s_client -connect <registry-host>:443 -showcerts </dev/null 2>/dev/null \
  > /tmp/full-chain.pem

# Extract the last cert in the chain
csplit -s -f /tmp/cert- /tmp/full-chain.pem '/-----BEGIN CERTIFICATE-----/' '{*}' 2>/dev/null
# The last cert file is the root CA (check: issuer == subject)
cp "$(ls -1 /tmp/cert-* | tail -1)" /tmp/root-ca.pem

# Verify it's self-signed
openssl verify -CAfile /tmp/root-ca.pem /tmp/root-ca.pem

# Clean up temp files
rm -f /tmp/cert-* /tmp/full-chain.pem
```

1. Use it with any npm command:

```bash
NODE_EXTRA_CA_CERTS=/tmp/root-ca.pem npm ci --strict-ssl=true
```

For persistent use, add to `.npmrc`:

```bash
cafile=/path/to/root-ca.pem
```

1. Alternatively, install the cert system-wide:

```bash
sudo cp /tmp/root-ca.pem /usr/local/share/ca-certificates/root-ca.crt
sudo update-ca-certificates
```

**Environment variables that DON'T work alone:**

- `NODE_TLS_REJECT_UNAUTHORIZED=0` — insufficient; npm's `strict-ssl`
  overrides it. Only works when combined with `--strict-ssl=false`.

**`ca=null` is the default, not a bypass.** Setting `ca=null` means "use
the system CA bundle" — it does NOT disable validation. Only
`strict-ssl=false` or `NODE_EXTRA_CA_CERTS` with a trusted CA actually
bypass the error.

**Critical: npm cache can mask TLS failures.** If `npm ci` succeeds
without expected TLS config, the packages were served from cache.
Always test with:

```bash
npm cache clean --force && rm -rf node_modules
```

### pip

```bash
pip install --trusted-host <host> <package>
# or persistently:
pip config set global.trusted-host <host>
```

### curl / wget

```bash
curl --insecure https://...
wget --no-check-certificate https://...
```

## Browser access

Use agent-browser when the resource requires a real browser (JS-rendered
SPAs, login flows, interactive scraping).

**Lightweight: fetch without a browser.** `agent-browser read <url>`
uses HTTP fetch (no Chrome) — good for text-heavy pages, docs, and
quick checks:

```bash
agent-browser read https://blocked-site.com
```

**Full browser:** for SPAs, interactive forms, and visual scraping:

```bash
agent-browser open https://blocked-site.com
agent-browser snapshot -i
agent-browser read  # extract rendered DOM
```

For geo-blocked sites, combine with proxy (see [Proxy](#proxy)):

```bash
agent-browser --proxy http://proxy:8080 open https://blocked-site.com
```

See the [agent-browser skill](agent-browser) for the full workflow.

## Archive access

Many geo-blocked pages are archived. Try web.archive.org first — it's
free, no proxy needed, and works for static content.

```bash
# Check if a page is archived
curl -sIL "https://web.archive.org/web/2025/https://blocked-site.com/page"

# Fetch archived content (use -L to follow redirects)
curl -sL "https://web.archive.org/web/2025/https://blocked-site.com/page"
```

Replace `2025` with any year — archive.org auto-redirects to the
nearest available snapshot.

**SPA warning:** JavaScript-rendered pages (React, Vue, Angular) won't
render in the archive — only the raw HTML is saved. For SPAs, use
[Browser access](#browser-access) with a proxy, or scrape the HTML for
visible text content.

For npm packages behind private registries, check if the package is
also published on the public npm registry or a mirror.

## Google Translate proxy

Zero-setup workaround for text pages. Google Translate can act as a
free proxy for geo-blocked content:

```bash
curl -sL "https://translate.google.com/translate?sl=auto&tl=en&u=https://blocked-site.com"
```

Not always reliable (some sites block the translate referrer), but
worth trying before setting up a full proxy.

## Proxy

Route traffic through a proxy in an allowed region.

### HTTP/HTTPS proxy

```bash
export http_proxy=http://proxy:8080
export https_proxy=http://proxy:8080
export no_proxy=localhost,127.0.0.1,.local

# npm respects these automatically
npm ci

# agent-browser
agent-browser --proxy http://proxy:8080 open https://blocked-site.com

# curl
curl --proxy http://proxy:8080 https://blocked-site.com
```

### SOCKS proxy

```bash
curl --socks5-hostname proxy:1080 https://blocked-site.com
```

## VPN

Last resort for full geo-bypass. Use a VPN provider with exit nodes in
the target region. Common CLI approaches:

```bash
# OpenVPN
sudo openvpn --config config.ovpn

# WireGuard
sudo wg-quick up wg0
```

After connecting, verify your exit region:

```bash
curl -s https://ipinfo.io/json | jq '.country, .city'
```

## DNS-based approaches

Some blocks are DNS-level. Try alternative resolvers:

```bash
# Google DNS
dig @8.8.8.8 blocked-site.com

# Cloudflare DNS
dig @1.1.1.1 blocked-site.com

# Use in curl
curl --dns-servers 8.8.8.8 https://blocked-site.com
```

**Note:** if TCP connects but the TLS handshake hangs or fails, the
block is at the IP or TLS level, not DNS. DNS resolver changes only
help when the domain itself fails to resolve.

## Certificate chain analysis

When debugging TLS errors, inspect the full chain:

```bash
openssl s_client -connect host:443 -showcerts </dev/null 2>/dev/null
```

Look for the `Verify return code` line. `19` = self-signed cert in
chain. The last cert in the chain (`i:` and `s:` are the same) is the
self-signed root — that's the one to trust with `NODE_EXTRA_CA_CERTS`.

## References

- [TLS chain troubleshooting](references/tls-troubleshooting.md) —
  detailed openssl debugging and npm gotchas
- [npm TLS/SSL docs](https://docs.npmjs.com/cli/v11/using-npm/config#strict-ssl)
- [Node.js TLS docs](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback)
- [agent-browser skill](agent-browser)
- [web.archive.org](https://web.archive.org)
