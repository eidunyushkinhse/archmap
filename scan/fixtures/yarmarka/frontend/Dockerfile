FROM node:20-alpine AS build
WORKDIR /src
COPY . .
RUN npm ci && npm run build

FROM nginx:1.27-alpine
COPY --from=build /src/dist /usr/share/nginx/html
