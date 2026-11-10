FROM python:3.12-slim AS site
RUN pip install mkdocs
FROM nginx:1.27-alpine
COPY --from=site /site /usr/share/nginx/html
