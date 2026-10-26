# One image per engine profile, built by compose.yaml's `browsers-<profile>` services.
# BASE_IMAGE is the profile's Playwright image (its pin in compose.yaml). The Playwright npm client
# must match that image's browser builds exactly, so PLAYWRIGHT_VERSION is the same release. Old
# images ship old Node; the engine runner (oracle/engine-runner.cjs) is written for Node >= 14 for
# that reason.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG PLAYWRIGHT_VERSION
# Extra npm packages for the analysis image only (css-tree, colorjs.io, @webref/css), plus the
# system tools the vendored WPT extractor needs (python3 for read-html.py, git for ls-files).
ARG EXTRA_PACKAGES=""
ARG APT_PACKAGES=""
RUN if [ -n "$APT_PACKAGES" ]; then apt-get update && apt-get install -y --no-install-recommends $APT_PACKAGES && rm -rf /var/lib/apt/lists/*; fi
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_registry=https://registry.npmjs.com/ \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /opt/lcr
RUN echo '{"name":"lcr-oracle","private":true,"version":"0.0.0"}' > package.json \
 && npm install --registry=https://registry.npmjs.com/ --save-exact playwright@${PLAYWRIGHT_VERSION} ${EXTRA_PACKAGES} \
 && node -e "require('playwright')" \
 && chmod -R a+rX /opt/lcr
ENV NODE_PATH=/opt/lcr/node_modules
