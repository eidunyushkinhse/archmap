FROM docker.io/nginxinc/nginx-unprivileged:1.29.3-alpine3.22-otel AS serve
RUN true
FROM serve
COPY static /usr/share/nginx/html
