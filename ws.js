import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export default class PriceMonitor {
  constructor(symbol = 'BTC-USD', proxyUrl = null) {
    this.symbol = symbol;
    this.proxyUrl = proxyUrl;
    this.ws = null;
    this.currentPrice = null;
    this.priceCallback = null;
    this.positionCallback = null;
    this.isConnected = false;
    this.lastUpdateTime = 0; 
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        const options = {};
        if (this.proxyUrl) {
          // 在 WebSocket 的 options 中加入 agent
          options.agent = new HttpsProxyAgent(this.proxyUrl);
          console.log(`[WS] Routing through proxy...`);
        }
        this.ws = new WebSocket('wss://perps.standx.com/ws-stream/v1', options);

        this.ws.on('open', () => {
          this.isConnected = true;
          this.subscribe();
          resolve();
        });

        this.ws.on('message', (data) => {
          const msg = JSON.parse(data);
          if (msg.channel === 'price' && msg.data) {
            this.currentPrice = parseFloat(msg.data.last_price);
            this.lastUpdateTime = Date.now();
            if (this.priceCallback) this.priceCallback(this.currentPrice);
          }
          if (msg.channel === 'position' && msg.data) {
            // 根据文档，直接把 data 对象传给 strategy
            if (this.positionCallback) this.positionCallback(msg.data);
          }
        });

        this.ws.on('error', (e) => { this.isConnected = false; });
        this.ws.on('close', () => { this.isConnected = false; this.reconnect(); });
        this.ws.on('pong', () => { this.lastUpdateTime = Date.now(); });
      } catch (error) { reject(error); }
    });
  }

  subscribe() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ subscribe: { channel: 'price', symbol: this.symbol } }));
      this.ws.send(JSON.stringify({ subscribe: { channel: 'position' } })); 
      console.log(`[WS] Subscribed to Price & Position`);
    }
  }

  reconnect() { setTimeout(() => this.connect(), 3000); }
  getStatus() {
    return { isConnected: this.isConnected, secondsSinceLastUpdate: (Date.now() - this.lastUpdateTime) / 1000 };
  }
  onPrice(cb) { this.priceCallback = cb; }
  onPosition(cb) { this.positionCallback = cb; }
  getPrice() { return this.currentPrice; }
  close() { if (this.ws) this.ws.close(); }
}