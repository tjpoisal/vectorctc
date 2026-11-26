# VectorCTC shared service: MCP over Streamable HTTP + REST API. Build from the repo root:
#   docker build -f examples/self-host/Dockerfile -t vectorctc .
FROM node:20-slim
WORKDIR /opt/vectorctc
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist ./dist
COPY data ./data
ENV CTC_FINDINGS_LOG=on
# The workspace (repos to gate) is mounted at /work. The server binds 127.0.0.1 by design; the compose file
# publishes it through a reverse proxy that adds TLS and auth.
WORKDIR /work
ENTRYPOINT ["node", "/opt/vectorctc/dist/index.js"]
CMD ["serve", "--http", "--port", "4317"]
