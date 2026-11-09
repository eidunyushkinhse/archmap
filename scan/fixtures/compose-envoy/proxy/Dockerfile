FROM alpine:3.20 AS certs
COPY extra.yaml /tmp/extra.yaml
RUN apk add --no-cache ca-certificates

FROM envoyproxy/envoy:v1.30
COPY --from=certs /etc/ssl/certs /etc/ssl/certs
COPY --chown=envoy:envoy envoy.yaml /etc/envoy/envoy.yaml
COPY docker-entrypoint.sh /
COPY overrides.yaml /etc/envoy/
ENTRYPOINT ["/docker-entrypoint.sh"]
