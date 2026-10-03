# ⚡ ArbiScan — CEX/DEX 套利扫描器

实时扫描 Hyperliquid、AsterDEX、Binance、OKX、Bybit、Gate 之间的套利机会，支持一键双边下单。

## 快速启动

```bash
# 方式 1: 直接用浏览器打开
open index.html

# 方式 2: 本地 HTTP 服务 (推荐，避免 CORS 问题)
python3 -m http.server 8080
# 然后访问 http://localhost:8080
```

## 功能

### 套利类型
| 类型 | 说明 |
|------|------|
| 资金费率套利 | 在资金费高的交易所做空，低的做多，赚取费率差 |
| 价差套利 | 同一资产在不同交易所价差超过手续费时搬砖 |
| 期现套利 | 现货 + 永续空单，收取资金费 |

### 支持交易所
- **DEX**: Hyperliquid、AsterDEX
- **CEX**: Binance、OKX、Bybit、Gate

### 下单功能
- 配置各交易所 API Key（本地存储，不上传服务器）
- 单边或双边一键下单
- 限价/市价选择
- 杠杆调节（1x/3x/5x/10x）
- 实时 P&L 预估（每次结算/日/周/月/年）

## 注意事项

1. **CORS 限制**: 部分 CEX API（如 Binance）禁止前端直接请求，建议通过后端代理或使用 CORS 插件
2. **Hyperliquid 下单**: 需要连接 EVM 钱包签名，前端直接调用暂不支持，建议在 HL 官网手动下单
3. **API Key 安全**: 只开启「交易」权限，务必禁用「提款」权限
4. **套利风险**: 资金费率可能改变方向，建议设置止损，单边暴露风险时及时平仓

## 后端代理 (可选)

如遇 CORS 问题，可在本地起一个简单代理：

```bash
npm install -g cors-anywhere
cors-anywhere  # 默认 8888 端口
```

然后在 `app.js` 中将 API URL 前缀改为 `http://localhost:8888/`。
