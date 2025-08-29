FROM node:20-bullseye

WORKDIR /app

# System deps for native modules like @discordjs/opus (node-gyp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --production

# Copy source
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "bot.js"]
