import axios from 'axios';
import { ethers } from 'ethers';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';

const API_BASE = 'https://api.standx.com';

export function generateEd25519KeyPair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const requestId = base58.encode(publicKey);
  return { privateKey, publicKey, requestId };
}

function parseJwt(token) {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
}

async function prepareSignIn(chain, walletAddress, requestId) {
  const url = `${API_BASE}/v1/offchain/prepare-signin?chain=${chain}`;
  const response = await axios.post(url, { address: walletAddress, requestId });
  if (!response.data.success) throw new Error('Failed to prepare sign-in');
  return response.data.signedData;
}

async function login(chain, signature, signedData, expiresSeconds = 604800) {
  const url = `${API_BASE}/v1/offchain/login?chain=${chain}`;
  const response = await axios.post(url, { signature, signedData, expiresSeconds });
  return response.data;
}

export async function authenticate(chain, walletAddress, privateKey) {
  const checksumAddress = ethers.getAddress(walletAddress);
  const { privateKey: edKey, requestId } = generateEd25519KeyPair();
  const signedDataJwt = await prepareSignIn(chain, checksumAddress, requestId);
  const payload = parseJwt(signedDataJwt);
  const messageToSign = payload.message.replace(/\r\n/g, '\n').trim();
  const wallet = new ethers.Wallet(privateKey);
  const signature = await wallet.signMessage(messageToSign);
  const loginResponse = await login(chain, signature, signedDataJwt);
  if (!loginResponse.token) throw new Error('No token in login response');
  return { token: loginResponse.token, signingKey: edKey, requestId };
}

export function generateRequestSignature(version, requestId, timestamp, payload, signingKey) {
  const key = signingKey instanceof Uint8Array ? signingKey : new Uint8Array(signingKey);
  const signMsg = `${version},${requestId},${timestamp},${payload}`;
  const signature = ed25519.sign(Buffer.from(signMsg, 'utf-8'), key);
  return Buffer.from(signature).toString('base64');
}