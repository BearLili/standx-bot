import Decimal from 'decimal.js';

export default class BidStrategy {
  constructor(api, priceMonitor, symbol, side = 'long') {
    this.api = api;
    this.priceMonitor = priceMonitor;
    this.symbol = symbol;
    this.side = side.toLowerCase(); // 'long' 或 'short'
    
    this.initialPrice = null;
    this.isProcessing = false;
    this.emergencyMode = false;
    this.watchdogTimer = null;
    
    // 策略参数
    this.offsetPercentage = 0.0022; 
    this.changeThreshold_high = 0.004; 
    this.changeThreshold_low = 0.0012; 
    this.leverage = 40;
    this.availableBalance = 0;

    this.reorder = this.reorder.bind(this);
    this.checkAndClosePositions = this.checkAndClosePositions.bind(this);
    this.clearAllOpenOrders = this.clearAllOpenOrders.bind(this);
  }

  // 根据多空方向计算挂单价格
  calculateOrderPrice(marketPrice) {
    const p = new Decimal(marketPrice);
    if (this.side === 'short') {
      // 做空：在市价上方挂卖单
      return p.times(new Decimal(1).plus(this.offsetPercentage)).toFixed(2);
    } else {
      // 做多：在市价下方挂买单
      return p.times(new Decimal(1).minus(this.offsetPercentage)).toFixed(2);
    }
  }

  // 根据多空方向判定是否需要撤单重挂
  shouldReorder(currentPrice) {
    if (!this.initialPrice) return true;
    
    const p = parseFloat(currentPrice);
    const i = parseFloat(this.initialPrice);
    const diff = p / i;

    if (this.side === 'short') {
      // 做空逻辑判定:
      // (diff <= 1 - 0.004) -> 价格跌太深，远离了上方的卖单
      // (diff >= 1 - 0.0012) -> 价格涨太高，逼近了上方的卖单
      return (diff <= (1 - this.changeThreshold_high)) || (diff >= (1 - this.changeThreshold_low));
    } else {
      // 做多逻辑判定 (原逻辑):
      let absDiff = Math.abs(diff - 1);
      return absDiff >= this.changeThreshold_high || absDiff <= this.changeThreshold_low;
    }
  }

  async checkAndClosePositions() {
    try {
      const posData = await Promise.race([
        this.api.queryPositions(this.symbol),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
      ]);

      const rawList = posData.result || posData.data || (Array.isArray(posData) ? posData : []);
      const finalItems = Array.isArray(rawList) ? rawList : (rawList.list || []);

      const activePositions = finalItems.filter(p => {
        const amount = new Decimal(String(p.qty || 0)).abs();
        return amount.gt(0) && p.symbol === this.symbol;
      });

      if (activePositions.length > 0) {
        for (const pos of activePositions) {
          const qty = new Decimal(String(pos.qty)).abs();
          const side = new Decimal(String(pos.qty)).gt(0) ? 'sell' : 'buy';
          
          console.error(`[EMERGENCY] 🚨 DETECTED! Qty: ${pos.qty} Side: ${side}. Closing...`);
          
          await this.clearAllOpenOrders();
          const res = await this.api.marketOrder(this.symbol, side, qty.toString());
          console.log(`[Risk] Market Close Success: ${JSON.stringify(res)}`);
          
          this.initialPrice = null; // 平仓后强制触发重挂
          await new Promise(r => setTimeout(r, 1000));
        }
        return true; 
      }
      return false; 
    } catch (e) {
      console.error('[Risk] ❌ Position Check Failed:', e.message);
      return false;
    }
  }

  calculateQty(price) {
    try {
      if (this.availableBalance <= 0) return 0;
      const qty = new Decimal(this.availableBalance).times(this.leverage).times(0.95).dividedBy(price);
      return (qty.toNumber() * 0.8).toFixed(3); 
    } catch (e) { return 0; }
  }

  async clearAllOpenOrders() {
    try {
      const openOrders = await this.api.queryOpenOrders(this.symbol);
      if (openOrders?.result?.length > 0) {
        const ids = openOrders.result.map(o => o.id);
        console.log(`[Strategy] 🗑️ Cleaning ${ids.length} residual orders...`);
        await this.api.cancelOrders(ids);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) { console.error('[Strategy] ❌ Clear failed:', e.message); }
  }

  async placeAndVerify(marketPrice) {
    const orderPrice = this.calculateOrderPrice(marketPrice);
    const orderSide = this.side === 'short' ? 'sell' : 'buy'; // 自动切换下单方向
    const qty = this.calculateQty(orderPrice);
    
    if(parseFloat(qty) <= 0) {
        console.log(`[Strategy] 💰 Balance insufficient`);
        return false;
    }

    console.log(`[Strategy] 📝 Submitting ${this.side.toUpperCase()}: Qty ${qty} @ Price ${orderPrice} (Balance: ${this.availableBalance})`);
    
    try {
      const res = await this.api.newOrder(this.symbol, orderSide, 'limit', qty, orderPrice);
      if (res.code !== 0) {
        console.error(`[Strategy] ❌ Server Rejected: ${res.message}`);
        return false;
      }

      console.log(`[Strategy] 🔍 Verifying order status on-chain...`);
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 1500)); 
        const openOrders = await this.api.queryOpenOrders(this.symbol);
        if (openOrders.result?.some(o => new Decimal(String(o.price)).equals(orderPrice))) {
          console.log(`[Strategy] ✅ ${this.side.toUpperCase()} Order VERIFIED.`);
          
          // --- 恢复你的 Live Range 打印 ---
          if (this.side === 'short') {
            console.log(`🎯[Live Range] 【${(orderPrice * (1 - this.changeThreshold_high)).toFixed(2)} ———— ${(orderPrice * (1 - this.changeThreshold_low)).toFixed(2)}】`);
          } else {
            console.log(`🎯[Live Range] 【${(orderPrice * (1 + this.changeThreshold_high)).toFixed(2)} ———— ${(orderPrice * (1 + this.changeThreshold_low)).toFixed(2)}】`);
          }
          
          this.initialPrice = orderPrice;
          return true;
        }
        console.log(`[Strategy] ⏳ Attempt ${i+1}: Not on-chain yet...`);
      }
      return false;
    } catch (e) { return false; }
  }

  async reorder(marketPrice) {
    if (this.isProcessing || this.emergencyMode) return;
    this.isProcessing = true;

    console.log(`\n--- 🔄 Cycle Start (${this.side.toUpperCase()} @ Market: ${marketPrice}) ---`);
    try {
      await this.checkAndClosePositions();
      await this.clearAllOpenOrders();
      await new Promise(r => setTimeout(r, 500)); 

      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);

      const success = await this.placeAndVerify(marketPrice);
      if (!success) this.initialPrice = null;
    } finally {
      this.isProcessing = false;
      console.log(`--- ✅ Cycle Finished ---\n`);
    }
  }

  startWatchdog() {
    this.watchdogTimer = setInterval(async () => {
      if (this.isProcessing) return; 

      const status = this.priceMonitor.getStatus();
      const isDead = (!status.isConnected && status.secondsSinceLastUpdate > 10) || status.secondsSinceLastUpdate > 30;

      if (isDead && !this.emergencyMode) {
        console.error(`[WATCHDOG] 🚨 Connection Lost! Lag: ${status.secondsSinceLastUpdate}s`);
        this.emergencyMode = true;
        await this.clearAllOpenOrders();
      } else if (!isDead && this.emergencyMode) {
        this.emergencyMode = false;
        this.initialPrice = null;
      }
      
      if (!this.isProcessing && !this.emergencyMode) {
        await this.checkAndClosePositions();
      }
    }, 5000); 
  }

  async start() {
    try {
      await this.checkAndClosePositions();
      const balance = await this.api.queryBalance();
      this.availableBalance = parseFloat(balance.cross_available);
      console.log(`[Init] 💰 Available: ${this.availableBalance} U`);

      await this.api.changeLeverage(this.symbol, this.leverage);
      this.startWatchdog();

      this.priceMonitor.onPrice(async (p) => {
        if (this.emergencyMode || this.isProcessing) return;
        if (!this.initialPrice) {
          await this.reorder(p);
        } else {
          // --- 恢复你的 Price Moved 日志 ---
          if (this.shouldReorder(p)) {
             console.log(`[Strategy] 🔄 Price moved out of range. Current: ${p}`);
             await this.reorder(p);
          }
        }
      });

      this.priceMonitor.onPosition(async (data) => {
        const qty = new Decimal(String(data.qty || 0)).abs();
        if (qty.gt(0)) {
          console.warn(`[Risk] ⚠️ WS Position Alert! Qty: ${data.qty}`);
          this.initialPrice = null;
          await this.reorder(this.priceMonitor.getPrice());
        }
      });
    } catch (e) { console.error('[Strategy] 💀 Start Error:', e.message); }
  }

  async stop() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    await this.checkAndClosePositions();
    await this.clearAllOpenOrders();
  }
}