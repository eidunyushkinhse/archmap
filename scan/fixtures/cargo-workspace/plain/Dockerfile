FROM rust:1.91
WORKDIR /app
COPY . .
RUN cargo build --release
CMD ["/app/target/release/plain-server"]
