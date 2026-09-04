# TLS Chain Troubleshooting

## Identify the error

```bash
openssl s_client -connect host:443 -showcerts </dev/null 2>/dev/null | grep "Verify return code"
```

| Code | Meaning                         | Fix                     |
| ---- | ------------------------------- | ----------------------- |
| 0    | OK                              | No issue                |
| 18   | Self-signed cert                | Trust the cert directly |
| 19   | Self-signed cert in chain       | Trust the root CA       |
| 20   | Unable to get local issuer cert | Intermediate CA missing |
| 21   | Unable to verify first cert     | Chain broken            |

## Extract the right cert

The chain from `openssl s_client -showcerts` is numbered starting at 0
(leaf). The **last cert** is usually the self-signed root.

```bash
# Extract cert N (0=leaf, 1=intermediate1, ..., last=root)
openssl s_client -connect host:443 -showcerts </dev/null 2>/dev/null \
  | awk "/-----BEGIN CERTIFICATE-----/{n++} n==N{print} /-----END CERTIFICATE-----/{if(n==N) exit}"
```

## Verify before trusting

```bash
# Verify root CA is self-signed
openssl verify -CAfile root-ca.pem root-ca.pem

# Verify full chain against root CA
openssl verify -CAfile root-ca.pem -untrusted full-chain.pem leaf.pem
```

## npm gotchas

1. **Cache masking:** `npm ci` succeeds with no TLS config? Packages
   were served from cache. Clean cache first: `npm cache clean --force`
2. **`NODE_TLS_REJECT_UNAUTHORIZED=0` is not enough:** npm's
   `strict-ssl` setting overrides it. Use `--strict-ssl=false`.
3. **`ca=null` is the default:** setting `ca=null` doesn't bypass
   validation — it means "use the system CA bundle".
4. **`cafile` in `.npmrc`:** setting `cafile=/path/to/cert.pem` is
   equivalent to `NODE_EXTRA_CA_CERTS` but persistent.
