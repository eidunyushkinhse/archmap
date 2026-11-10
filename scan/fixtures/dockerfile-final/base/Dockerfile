FROM alpine:3.24 AS build
RUN apk add curl
FROM registry.access.redhat.com/ubi9-micro
COPY --from=build /usr/bin/curl /usr/bin/curl
