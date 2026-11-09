FROM rust:1.80 AS build
COPY . /src
RUN cd /src && cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/jobs /usr/local/bin/jobs
ENTRYPOINT ["jobs"]
