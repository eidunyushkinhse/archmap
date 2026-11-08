FROM rust:1.91 AS builder
ARG BIN
WORKDIR /app
COPY . .
RUN cargo build --release --bin ${BIN}

FROM debian:bookworm-slim
ARG BIN
ENV BIN=$BIN
COPY --from=builder /app/target/release/$BIN /usr/local/bin
ENTRYPOINT ["/bin/sh", "-c", "/usr/local/bin/$BIN"]
