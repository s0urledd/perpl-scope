# Monode backend (github.com/monad-developers/monode), pinned and built from
# source. It reads this host's execution event ring and serves the filtered
# events over a WebSocket on the compose network only.
FROM rust:1.91-slim AS build
ARG MONODE_REPO=https://github.com/monad-developers/monode.git
ARG MONODE_REF=d27d79282935da3ae34dabba6d65c9eeeaac7799
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gcc g++ make cmake pkg-config libssl-dev libclang-dev libzstd-dev libhugetlbfs-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q && git remote add origin "$MONODE_REPO" && git fetch -q --depth 1 origin "$MONODE_REF" && git checkout -q FETCH_HEAD
RUN cargo build --release --locked --bin backend

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libzstd1 libhugetlbfs0 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/release/backend /app/backend
# Only Perpl exchange logs and block lifecycle events leave the process.
COPY restricted_filters.json /app/restricted_filters.json
EXPOSE 8443
ENTRYPOINT ["/app/backend"]
CMD ["--server-addr", "0.0.0.0:8443", "--health-server-addr", "127.0.0.1:7000"]
