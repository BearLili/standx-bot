/**
 * Redis 配置示例
 * 
 * 将以下配置存储到 Redis 中：
 * 
 * redis-cli
 * > SET standx:account:1 '{"chain":"bsc","walletAddress":"0x...","privateKey":"0x...","signingKey":"..."}'
 */

// 示例 1: BSC 链配置
const bscConfig = {
  chain: 'bsc',
  walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
  privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  signingKey: 'base64_encoded_ed25519_private_key_here',
  symbol: 'BTC-USD',
};

// 示例 2: Solana 链配置
const solanaConfig = {
  chain: 'solana',
  walletAddress: 'SolanaWalletAddressHere...',
  privateKey: 'base58_encoded_solana_private_key_here',
  signingKey: 'base64_encoded_ed25519_private_key_here',
  symbol: 'BTC-USD',
};

/**
 * 如何生成 Signing Key
 * 
 * const { generateEd25519KeyPair } = require('./auth');
 * const { privateKey } = generateEd25519KeyPair();
 * const signingKeyBase64 = Buffer.from(privateKey).toString('base64');
 * console.log('Signing Key:', signingKeyBase64);
 */

/**
 * 如何存储到 Redis
 * 
 * 使用 Node.js:
 * 
 * const redis = require('redis');
 * const client = redis.createClient();
 * await client.connect();
 * await client.set('standx:account:1', JSON.stringify(bscConfig));
 * 
 * 或使用 Redis CLI:
 * 
 * redis-cli
 * > SET standx:account:1 '{"chain":"bsc","walletAddress":"0x...","privateKey":"0x...","signingKey":"..."}'
 */

module.exports = { bscConfig, solanaConfig };
