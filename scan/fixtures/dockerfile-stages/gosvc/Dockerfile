FROM golang:1.22 AS builder
RUN go build -o /out/app ./cmd/app
FROM scratch
COPY --from=builder /out/app /app
ENTRYPOINT ["/app"]
