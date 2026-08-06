# Build stage
FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
# AUDIT-D5: the same npm install the entry filed against backend/Dockerfile. This
# image is not built by docker-compose.yml or by CI (ci-npm.yml lists this file as a
# path trigger only, and installs with `npm ci` on the runner), but the shape is
# identical and the fix is one word.
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
