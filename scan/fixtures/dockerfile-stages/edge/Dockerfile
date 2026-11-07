FROM golang:1.22 AS build
RUN go build -o /edge .
FROM alpine:3.20
COPY --from=build /edge /edge
CMD ["/edge"]
