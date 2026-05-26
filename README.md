# Trading Analyst App

AI-powered trading analysis guide with PDF export and interactive charts.

## Setup

1. **Set your Anthropic API key:**
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

2. **Run the proxy server:**
   ```bash
   npm start
   ```
   Server listens on `http://localhost:8787`

3. **Use the app:**
   - Open `trading-analysis-guide.html` in your browser
   - Enable "Use local proxy"
   - Set proxy URL to `http://localhost:8787/analyze`

## Deployment on Render

This repo is configured for automatic deployment on Render via `render.yaml`:

- Requires `ANTHROPIC_API_KEY` environment variable
- Runs on Node.js 18+
- Free tier compatible

## Testing

Run smoke tests locally:
```bash
node test-proxy.mjs
```