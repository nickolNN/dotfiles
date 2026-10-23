# Extra CA certificates (optional)

Drop root / intermediate certificates of **any** name here — `*.pem` or `*.crt`,
one file per certificate or a bundle — then rebuild the image:

```sh
./build.sh
```

`dotfiles-agent/Dockerfile` reads this whole folder and trusts everything it
finds, in **both** stores that matter (they are independent):

- OpenSSL — `git`, `curl`, `openssl`, chromium/Playwright
- Node — `node`, `npm`, `yarn`, the pi agent and its MCP servers, through
  `NODE_EXTRA_CA_CERTS`. Node ships its own trust bundle and ignores the system
  one, so `update-ca-certificates` alone never fixes `yarn install`.

## It is fine for this folder to be empty

On a machine with no corporate CA there is nothing to put here, and the build
says so without failing:

```text
CA: none in dotfiles-agent/certs/ — using the standard Debian store.
CA: 0 extra certificate file(s) trusted (0 = standard Debian store, fine)
```

The folder itself must stay in git (`.gitkeep`) because the image build `COPY`s
it; everything inside is gitignored, so certificates never end up in history.

## Certificates only — no private keys

A file containing `-----BEGIN … PRIVATE KEY-----` is refused by `build.sh`
before the build starts. Keys do not belong in a build context.

Also refused: files with no `-----BEGIN CERTIFICATE-----` in them — a CSR
(`CERTIFICATE REQUEST`), text, or an empty file. `update-ca-certificates` does
not inspect content, it appends whatever a `*.crt` file holds straight into the
system bundle, so this filter is what keeps junk out of the trust store.

## Which file do I need?

The certificate that issued the internal site. Find it from a machine that
already trusts the site:

```sh
openssl s_client -connect <internal-host>:443 -servername <internal-host> \
  </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject
```

If the issuer is corporate (not Let's Encrypt / a public CA), export the root CA
from that machine's trust store, or fetch it from the internal PKI page, and put
it here. Multiple environments → multiple files, any names.

## Check it worked

```sh
agent-attach -- bash -lc 'echo "$NODE_EXTRA_CA_CERTS"; \
  grep -c "BEGIN CERTIFICATE" "$NODE_EXTRA_CA_CERTS"; \
  openssl s_client -connect <internal-host>:443 -servername <internal-host> \
    </dev/null 2>/dev/null | grep "Verify return code"'
```

Both Node and OpenSSL must accept the chain — `Verify return code: 0` together
with a Node TLS error means only one store got the certificate.
