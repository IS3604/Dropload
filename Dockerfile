FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-pip \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --upgrade yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
