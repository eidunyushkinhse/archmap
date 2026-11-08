FROM rust:1.80 AS build
COPY . /src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/app /usr/local/bin/app
ENTRYPOINT ["app"]
