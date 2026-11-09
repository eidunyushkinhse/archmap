FROM golang:1.22 AS build
COPY . /src
RUN cd /src && go build -o /app .

FROM gcr.io/distroless/base
COPY --from=build /app /app
ENTRYPOINT ["/app"]
