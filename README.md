# KING AI WhatsApp Engine

Node.js service for managing separate WhatsApp Web sessions for KING AI users.

## Important
This first version uses the unofficial Baileys library. It is not the official WhatsApp Business Platform. Use only with accounts you control, obtain recipients' consent, follow WhatsApp policies, and avoid unsolicited bulk messaging. Accounts may be restricted.

## Required environment variables
- `ENGINE_API_KEY`: secret used by KING AI to authenticate API calls.
- `WHATSAPP_WEBHOOK_TOKEN`: secret sent with outbound webhook events.
- `SESSION_DIR`: persistent session directory; on Railway use `/data/sessions`.
- `BASE44_WEBHOOK_URL`: optional HTTPS endpoint in Base44 that receives events.

## API
All `/api/*` routes require `x-api-key: YOUR_ENGINE_API_KEY`.

- `GET /health`
- `POST /api/whatsapp/connect` JSON: `{ "userId": "base44-user-id" }`
- `GET /api/whatsapp/status/:userId`
- `POST /api/whatsapp/send` JSON: `{ "userId": "base44-user-id", "to": "22890000000", "message": "Hello" }`
- `POST /api/whatsapp/logout` JSON: `{ "userId": "base44-user-id" }`

QR codes are returned as data URLs in the `qr` field from the status endpoint.

## Railway deployment
1. Deploy this repository from GitHub.
2. Add `ENGINE_API_KEY` and `WHATSAPP_WEBHOOK_TOKEN` as Railway variables.
3. Add a Railway Volume mounted at `/data` so WhatsApp sessions survive restarts.
4. Generate a public HTTPS domain.
5. Set `SESSION_DIR=/data/sessions`.
6. Set `BASE44_WEBHOOK_URL` only after configuring the receiving webhook in Base44.

Do not expose API keys in browser-side code. Base44 should call this service from secure server-side functions.
