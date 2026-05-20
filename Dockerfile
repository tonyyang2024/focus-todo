FROM node:24-slim

# Install Python + pip
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
