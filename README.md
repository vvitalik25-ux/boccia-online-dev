# Boccia development server

Independent Cloudflare Worker for https://vvitalik25-ux.github.io/boccia-game/.

Production game and server remain unchanged. This repository starts as a copy of boccia-online-mode at the commit recorded in source-commit.txt; rooms and storage must never be bound to the production Worker.

Deploy: npm ci && npm run deploy
Tests: npm run test:network && npm run test:clock
Worker: boccia-online-dev
