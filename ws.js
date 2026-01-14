import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export default class PriceMonitor {
  constructor(symbol = 'BTC-USD', proxyUrl = null) {
    this.symbol = symbol;
    this.proxyUrl = proxyUrl;
    this.ws = null;
    this.currentPrice = null;
    this.priceCallback = null;
    
    this.isConnected = false;
    this.lastUpdateTime = 0; 

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.reconnectDelay = 3000;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        const options = {};
        if (this.proxyUrl) {
          options.agent = new HttpsProxyAgent(this.proxyUrl);
        }

        this.ws = new WebSocket('wss://perps.standx.com/ws-stream/v1', options);

        this.ws.on('open', () => {
          console.log(`[WS] Connected to ${this.symbol}${this.proxyUrl ? ' (via proxy)' : ''}`);
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.subscribe();
          resolve();
        });

        this.ws.on('message', (data) => this.handleMessage(data));

        this.ws.on('error', (error) => {
          this.isConnected = false;
          console.error('[WS] Error:', error.message);
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          console.log('[WS] Connection closed, reconnecting...');
          this.reconnect();
        });

        this.ws.on('pong', () => {
          this.lastUpdateTime = Date.now();
        });
      } catch (error) {
        this.isConnected = false;
        reject(error);
      }
    });
  }

  subscribe() {
    if (this.ws.readyState === WebSocket.OPEN) {
      const message = { subscribe: { channel: 'price', symbol: this.symbol } };
      this.ws.send(JSON.stringify(message));
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      if (message.channel === 'price' && message.data) {
        this.currentPrice = parseFloat(message.data.last_price);
        this.lastUpdateTime = Date.now();
        if (this.priceCallback) this.priceCallback(this.currentPrice);
      }
    } catch (error) {
      console.error('[WS] Parse error:', error);
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      secondsSinceLastUpdate: this.lastUpdateTime === 0 ? 0 : (Date.now() - this.lastUpdateTime) / 1000
    };
  }

  onPrice(callback) { this.priceCallback = callback; }
  getPrice() { return this.currentPrice; }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    setTimeout(() => {
      this.connect().catch(err => console.error('[WS] Retry failed'));
    }, this.reconnectDelay);
  }

  close() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.isConnected = false;
    }
  }
}