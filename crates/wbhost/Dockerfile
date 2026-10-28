# Workbook host (build context: repo root). One instance per region for now:
# actors are in-memory, so the service must not be scaled past one replica.
# Build on the same Debian release as the runtime image so glibc versions match.
FROM rust:1.95-slim-bookworm AS build
WORKDIR /repo
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY spikes spikes
RUN cargo build --release -p wbhost

FROM debian:bookworm-slim
COPY --from=build /repo/target/release/wbhost /usr/local/bin/wbhost
# Runs as root: Railway mounts volumes root-owned, and /data is a volume.
ENV DATA_DIR=/data PORT=8790
EXPOSE 8790
CMD ["wbhost"]
