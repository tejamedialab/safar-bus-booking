# ---- build stage: compile server + client
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime stage: production deps + compiled output only
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --omit=dev --no-audit --no-fund -w server
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
EXPOSE 4000
CMD ["node", "server/dist/src/server.js"]
