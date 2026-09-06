# Dockerfile for forge
# Multi-platform isolated test environment

FROM node:22-bookworm-slim

# Install system utilities: git, ripgrep, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Build and install forge globally
WORKDIR /opt/forge

COPY package*.json ./
COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY src/ ./src/

RUN npm install && npm run build && npm link

# Create workspace directory for user mounts
WORKDIR /workspace

ENTRYPOINT ["forge"]
