# Trading Analyst App

AI-assisted technical analysis with disciplined execution and honest journaling.

## Deployment on Render

1. **Add your Anthropic API key** to Render environment variables
2. **Service will auto-start** on your Render URL
3. **Open the URL** in your browser to access the app

## Features

- **Chart Analysis**: Upload charts for AI-powered multi-timeframe analysis
- **Live Data**: Real-time market data from multiple exchanges
- **Risk Calculator**: Position sizing with strict risk management
- **Trading Journal**: Log and review your trades
- **AI Coach**: Personalized trading guidance

## Local Development

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
node proxy-server.js
```

Then open `http://localhost:8787` in your browser.
