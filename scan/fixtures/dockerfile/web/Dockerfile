# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /src
RUN npm ci \
    && npm run build
FROM nginx:1.27-alpine
COPY --from=build /src/dist /usr/share/nginx/html
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
