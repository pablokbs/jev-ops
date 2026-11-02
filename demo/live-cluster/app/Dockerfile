# jev-ops live-cluster demo app.
# Deliberately tiny: Node builtins only, no package.json, no node_modules.
FROM node:20-alpine

WORKDIR /app
COPY server.js .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]