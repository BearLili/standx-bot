import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { generateRequestSignature } from './auth.js';

const BASE_URL = 'https://perps.standx.com';

export default class StandXAPI {
  constructor(token, signingKey, authRequestId, proxyUrl = null) {
    this.token = token;
    this.authRequestId = authRequestId;
    this.sessionId = uuidv4();
    this.signingKey = typeof signingKey === 'string' ? new Uint8Array(Buffer.from(signingKey, 'base64')) : signingKey;

    // 初始化 Axios 客户端
    const axiosConfig = {
      baseURL: BASE_URL,
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    };

    if (proxyUrl) {
      console.log(`[API] 🌐 Routing through proxy: ${proxyUrl}`);
      const agent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpsAgent = agent;
      axiosConfig.proxy = false; 
    }

    this.client = axios.create(axiosConfig);
  }

  getSignedHeaders(payload) {
    const requestId = uuidv4();
    const timestamp = Date.now();
    const signature = generateRequestSignature('v1', requestId, timestamp, JSON.stringify(payload), this.signingKey);
    return {
      'Authorization': `Bearer ${this.token}`,
      'x-request-sign-version': 'v1',
      'x-request-id': requestId,
      'x-request-timestamp': timestamp,
      'x-request-signature': signature,
      'x-session-id': this.sessionId,
    };
  }

  async queryBalance() {
    const response = await this.client.get('/api/query_balance', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    return response.data;
  }

  async changeLeverage(symbol, leverage) {
    const payload = { symbol, leverage: parseInt(leverage) };
    const response = await this.client.post('/api/change_leverage', payload, { 
      headers: this.getSignedHeaders(payload) 
    });
    return response.data;
  }

  async queryOpenOrders(symbol) {
    const response = await this.client.get('/api/query_open_orders', {
      headers: { 'Authorization': `Bearer ${this.token}` },
      params: { symbol }
    });
    return response.data;
  }

  async cancelOrders(order_id_list) {
    const payload = { order_id_list };
    const response = await this.client.post('/api/cancel_orders', payload, { 
      headers: this.getSignedHeaders(payload) 
    });
    return response.data;
  }

  async newOrder(symbol, side, order_type, qty, price) {
    const payload = { 
      symbol, 
      side, 
      order_type, 
      qty: String(qty), 
      price: String(price), 
      time_in_force: 'gtc', 
      reduce_only: false 
    };
    const response = await this.client.post('/api/new_order', payload, { 
      headers: this.getSignedHeaders(payload) 
    });
    return response.data;
  }
}