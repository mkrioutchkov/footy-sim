# Footy Manager — single-image build: compiles the C++ engine (g++), builds the frontend,
# and serves the whole app (API + static SPA + match socket) from the Fastify backend on one
# port. Deploy this to any container host (Fly.io / Render / a VM) to play from your phone.
#
#   docker build -t footy .
#   docker run -p 4000:4000 -v footy-data:/app/web/backend/data footy
#   → open http://<host>:4000  (register → create club → Play → Watch)
#
# Plain-English tactics need an LLM: pass TACTICS_LLM_* at runtime (see docs/); the rest of the
# game (dial tactics, matches, seasons) runs without one.
FROM node:22-bookworm

# g++ toolchain for the native engine build.
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Source, then build the engine (-> build/live.exe) and the frontend (-> dist/).
COPY . .
RUN npm run native:build:linux \
    && npx vite build

# Persist the SQLite DB (accounts/leagues) on a mounted volume.
ENV FOOTY_HOST=0.0.0.0 \
    FOOTY_PORT=4000
VOLUME ["/app/web/backend/data"]
EXPOSE 4000

CMD ["npm", "run", "serve"]
