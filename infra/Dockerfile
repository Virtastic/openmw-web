# SPDX-License-Identifier: GPL-3.0-or-later
# openmw-web as a self-contained static-site container: nginx + the built site, serving
# the cross-origin-isolation headers itself so it works behind ANY host-routing reverse
# proxy on the shared box. TLS is terminated upstream (the shared proxy / Cloudflare).
#
# Build context is the REPO ROOT (needs infra/nginx.conf + play/). The large engine
# artifacts (openmw.wasm/.data/.js) are gitignored; CI downloads them into play/ from a
# GitHub Release before building (see .github/workflows/deploy-openmw.yml).
FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/nginx.conf /etc/nginx/conf.d/openmw.conf

# Front-end (in git) + engine artifacts (fetched into play/ by CI).
# The RELEASE WEB ROOT, as-is. The engine lives under e/<hash>/ (content-versioned by
# version-engine.sh, with index.html stamped to match) and never at the root, so copying
# play/openmw.* would build an image that 404s on its own loader. build-openmw-image unzips the
# release bundle into dist/web; `docker build -f infra/Dockerfile .` locally needs the same.
COPY dist/web/ /usr/share/nginx/html/

EXPOSE 80
