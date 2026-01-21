import crypto from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import axios from 'axios';

// 补齐全局环境缺少的 Web Crypto API
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

import { initRedis, getConfig, closeRedis } from './config.js';
import { authenticate } from './auth.js';
import StandXAPI from './api.js';
import PriceMonitor from './ws.js';
import BidStrategy from './strategy.js';

async function main() {
  let priceMonitor;
  let strategy;
  let isCleaningUp = false;

  const emergencyCleanup = async (reason) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.log(`\n[System] Shutdown: ${reason}`);
    try {
      if (strategy) await strategy.stop();
      if (priceMonitor) priceMonitor.close();
      await closeRedis();
      console.log('[System] Safe Exit.');
    } catch (e) {
      console.error('[System] Cleanup Error:', e.message);
    } finally {
      process.exit(reason === 'error' ? 1 : 0);
    }
  };

  process.on('SIGINT', () => emergencyCleanup('SIGINT'));
  process.on('SIGTERM', () => emergencyCleanup('SIGTERM'));
  process.on('unhandledRejection', (e) => emergencyCleanup('error'));
  process.on('uncaughtException', (e) => emergencyCleanup('error'));

  try {
    await initRedis(process.env.REDIS_HOST || 'localhost', process.env.REDIS_PORT || 6379);
    const accountKey = process.env.ACCOUNT_KEY || 'standx:account:1';
    const config = await getConfig(accountKey);

    // 读取命令行传入的 SIDE 参数，默认为 long
    const side = config.side || process.env.SIDE || 'long'; 
    console.log(`[System] 🚀 Bot Direction: ${side.toUpperCase()}`);

    if (!config) throw new Error('Config not found');

    // 1. 获取并处理代理地址
    const rawProxy = config.proxy || null;
    const proxy = formatProxyUrl(rawProxy);
    
    if (proxy) {
      try {
        const response = await axios.get('https://api.ipify.org?format=json', { 
          httpsAgent: new HttpsProxyAgent(proxy), 
          timeout: 5000 
        });
        console.log(`[System] 🌐 Proxy Success! IP is: ${response.data.ip}`);
      } catch (e) {
        console.error(`[System] ❌ Proxy Failed: ${e.message}`);
      }
    }

    const { chain, walletAddress, privateKey, symbol = 'BTC-USD' } = config;

    console.log(`[Main] Authenticating ${walletAddress}...`);
    const authData = await authenticate(chain, walletAddress, privateKey);

    const api = new StandXAPI(authData.token, authData.signingKey, authData.requestId, proxy);
    
    priceMonitor = new PriceMonitor(symbol, proxy);
    await priceMonitor.connect();

    strategy = new BidStrategy(api, priceMonitor, symbol, side);
    await strategy.start();

    console.log('✅ Bot running. Ctrl+C to exit.');
    setInterval(() => {}, 1000);

  } catch (error) {
    console.error('Startup Error:', error.message);
    await emergencyCleanup('error');
  }
}

function formatProxyUrl(rawProxy) {
  if (!rawProxy) return null;
  if (rawProxy.startsWith('http')) return rawProxy;
  const parts = rawProxy.split(':');
  if (parts.length === 4) {
    const [ip, port, user, pass] = parts;
    return `http://${user}:${pass}@${ip}:${port}`;
  }
  return rawProxy;
}

main();