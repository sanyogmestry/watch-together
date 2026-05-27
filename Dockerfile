# Use a lightweight Node.js base image
FROM node:20-bullseye-slim

# Install system dependencies (ffmpeg and ffprobe)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy dependency definitions and install production packages
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of the application files
COPY . .

# Expose the application port
EXPOSE 3000

# Set production environment variables
ENV PORT=3000
ENV NODE_ENV=production

# Start the application
CMD ["node", "server.js"]
