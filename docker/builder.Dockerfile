# Builds and tests LightningCSS checkouts. The toolchain matches the repo's rust-toolchain.toml
# (passed as RUST_CHANNEL), installed at image build time so containers can run as the host user.
ARG RUST_CHANNEL=1.96.0
FROM rust:${RUST_CHANNEL}-bookworm
ARG RUST_CHANNEL
ARG NODE_MAJOR=24
RUN rustup toolchain install ${RUST_CHANNEL} --profile minimal --component rustfmt,clippy \
 && rustup default ${RUST_CHANNEL} \
 && rustup target add --toolchain ${RUST_CHANNEL} wasm32-unknown-unknown \
 && chmod -R a+rwX /usr/local/rustup /usr/local/cargo
# Node + Yarn 1 for the JS lane (yarn build / yarn test / yarn tsc), mirroring CI.
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g --registry=https://registry.npmjs.com/ yarn@1.22.22 \
 && rm -rf /var/lib/apt/lists/*
ENV CARGO_TERM_COLOR=never \
    npm_config_registry=https://registry.npmjs.com/ \
    YARN_REGISTRY=https://registry.npmjs.com/
WORKDIR /src
