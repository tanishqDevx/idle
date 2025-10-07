FROM node:20-alpine

WORKDIR /app

# Install only the two dependencies directly
RUN npm install express dockerode --omit=dev

# Copy application code
COPY server.js /app/

EXPOSE 8000

CMD ["node", "server.js"]
