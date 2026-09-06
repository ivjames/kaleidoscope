# Deploying Kaleidoscope

Target: **https://kaleidoscope.lab980.com** — served from the lab980 droplet (conventions in
the `ivjames/lab980.com` repo's `CLAUDE.md`).

The site is static files with no dependencies: no build step, no app process,
no port, no pm2, no database. nginx serving the git checkout *is* the
deployment. Everything is driven by the operate CLI at `bin/kaleidoscope`.

> Why not `provision-site`? That script scaffolds proxy-shaped sites (an app on
> a local port). This site has no app, so `kaleidoscope setup` writes its own
> static vhost instead — same DNS/doctl, security-headers and certbot shape.

## One-time bring-up (on the droplet, as root)

```bash
git clone https://github.com/ivjames/kaleidoscope /var/www/kaleidoscope
ln -sf /var/www/kaleidoscope/bin/kaleidoscope /usr/local/bin/kaleidoscope
kaleidoscope setup
```

`kaleidoscope setup` is idempotent and does, in order:

1. **DNS** — `doctl` A record `kaleidoscope.lab980.com -> droplet IP` (skipped if it already
   exists; `--no-dns` to skip, `--ip` to override autodetect).
2. **nginx** — static vhost from `deploy/nginx.conf.template` installed as
   `/etc/nginx/sites-available/kaleidoscope.lab980.com`, symlinked into `sites-enabled/`,
   `nginx -t` + reload. Root is the checkout; `index.html` is served
   `Cache-Control: no-cache` so deploys are live on the next visit; dotfiles
   and `*.md` are denied. An existing vhost is left untouched (certbot owns it
   after TLS).
3. **TLS** — waits for DNS to resolve, then
   `certbot --nginx -d kaleidoscope.lab980.com --redirect -n`. If DNS is still propagating it
   prints the exact certbot command to re-run.

## Deploying updates

Land changes on `main` (via a PR — see `CLAUDE.md`), then on the droplet:

```bash
kaleidoscope deploy
```

That is `git fetch` + `git reset --hard origin/main` of the checkout, plus a
`sed` that stamps the deployed commit into the page's `BUILD` constant if it
has one. No build, no restart, no reload.

## Check it

```bash
kaleidoscope status              # HEAD commit, live probe, cert days
health-check --site kaleidoscope # the droplet-wide auditor also covers it
```

## The camera backdrop needs a header change

The Backdrop control can put a camera behind the glass, and on the droplet that
will not work as things stand. Every lab980 vhost includes
`snippets/lab980-security-headers.conf`, which `fix-security-headers` in the
`ivjames/lab980.com` repo writes as:

```
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

An empty allowlist switches the camera off for the whole document, so
`getUserMedia` rejects before any permission prompt appears. The page detects
this where the browser exposes the policy (Chromium does) and says so rather
than blaming the user.

Nothing else in the feature is affected: **screen share** is governed by
`display-capture`, which that header does not name, so it defaults to `self`
and works; **file upload and drag-drop** touch no policy at all.

Turning the camera on is a platform decision, not a change to make here — it
means relaxing the shared header for this site, in the lab980 repo, to
something like `camera=(self)`. Until that happens the control is present and
fails with an accurate message.

## Overrides

- `KALEIDOSCOPE_FQDN` — serve under a different name (default `kaleidoscope.lab980.com`)
- `KALEIDOSCOPE_BRANCH` — deploy a different branch (default `main`)
