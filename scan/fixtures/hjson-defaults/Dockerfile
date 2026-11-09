FROM rust:1.80 AS build
COPY . /app
RUN cargo build --release
CMD ["/app/target/release/forum"]
