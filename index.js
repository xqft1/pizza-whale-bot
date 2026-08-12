import "dotenv/config";
import { ethers } from "ethers";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL;

const PIZZA_TOKEN = "0x831A3962e31037cf4Eb8847cb7eA05aaC1Db35B6";
const SATO_TOKEN = "0x829f4B62EEBE12Af653b4dD4fFc480966F7d7f09";
const PAIR_ADDRESS = "0x390B5EADf8192840b784228E5c712f298c7c2DC8";

const DEXSCREENER_URL =
  "https://dexscreener.com/ethereum/0x390B5EADf8192840b784228E5c712f298c7c2DC8";

// Minimum USD value required to trigger an alert
const MIN_USD_BUY = 5;

// Cache SATO price for 60 seconds
const PRICE_CACHE_MS = 60_000;

let cachedSatoUsdPrice = null;
let cachedPriceTime = 0;

if (!BOT_TOKEN || !CHAT_ID || !RPC_URL) {
  throw new Error("Missing BOT_TOKEN, CHAT_ID or RPC_URL in .env");
}

const provider = new ethers.WebSocketProvider(RPC_URL);
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const pairAbi = [
  "event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const erc20Abi = [
  "function decimals() view returns (uint8)",
];

const pair = new ethers.Contract(PAIR_ADDRESS, pairAbi, provider);
const pizza = new ethers.Contract(PIZZA_TOKEN, erc20Abi, provider);
const sato = new ethers.Contract(SATO_TOKEN, erc20Abi, provider);

const shortAddress = (addr) =>
  `${addr.slice(0, 6)}...${addr.slice(-4)}`;

const formatNum = (num, maxDecimals = 2) =>
  Number(num).toLocaleString("en-US", {
    maximumFractionDigits: maxDecimals,
  });

const getTier = (usdValue) => {
  if (usdValue >= 500) return "👑🍕 PIZZA LEGEND ALERT";
  if (usdValue >= 100) return "🐋🍕 PIZZA WHALE ALERT";
  if (usdValue >= 25) return "🦈🍕 PIZZA SHARK ALERT";
  return "🍕🔥 FRESH PIZZA BUY";
};

async function getSatoUsdPrice() {
  const now = Date.now();

  if (
    cachedSatoUsdPrice !== null &&
    now - cachedPriceTime < PRICE_CACHE_MS
  ) {
    return cachedSatoUsdPrice;
  }

  const response = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${SATO_TOKEN}`
  );

  if (!response.ok) {
    throw new Error(
      `DexScreener API error: ${response.status}`
    );
  }

  const data = await response.json();
  const pairs = data.pairs || [];

  const bestPair = pairs
    .filter(
      (p) =>
        p.chainId === "ethereum" &&
        Number(p.priceUsd) > 0
    )
    .sort(
      (a, b) =>
        Number(b.liquidity?.usd || 0) -
        Number(a.liquidity?.usd || 0)
    )[0];

  if (!bestPair) {
    throw new Error("Could not determine SATO USD price");
  }

  cachedSatoUsdPrice = Number(bestPair.priceUsd);
  cachedPriceTime = now;

  console.log(
    "Updated SATO price:",
    `$${cachedSatoUsdPrice}`
  );

  return cachedSatoUsdPrice;
}

async function main() {
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();

  const pizzaDecimals = await pizza.decimals();
  const satoDecimals = await sato.decimals();

  console.log("🍕 Pizza Whale Alert bot running...");
  console.log("Watching pair:", PAIR_ADDRESS);
  console.log("Minimum alert: $", MIN_USD_BUY);

  pair.on(
    "Swap",
    async (
      sender,
      amount0In,
      amount1In,
      amount0Out,
      amount1Out,
      to,
      event
    ) => {
      try {
        let pizzaBought = 0;
        let satoSpent = 0;

        // PIZZA is token0
        if (token0 === PIZZA_TOKEN.toLowerCase()) {
          pizzaBought = Number(
            ethers.formatUnits(
              amount0Out,
              pizzaDecimals
            )
          );

          satoSpent = Number(
            ethers.formatUnits(
              amount1In,
              satoDecimals
            )
          );
        }

        // PIZZA is token1
        if (token1 === PIZZA_TOKEN.toLowerCase()) {
          pizzaBought = Number(
            ethers.formatUnits(
              amount1Out,
              pizzaDecimals
            )
          );

          satoSpent = Number(
            ethers.formatUnits(
              amount0In,
              satoDecimals
            )
          );
        }

        // Ignore sells
        if (pizzaBought <= 0 || satoSpent <= 0) {
          return;
        }

        // Get current SATO USD price
        const satoUsdPrice = await getSatoUsdPrice();

        // Calculate USD value of the buy
        const usdValue = satoSpent * satoUsdPrice;

        // Ignore buys below minimum USD threshold
        if (usdValue < MIN_USD_BUY) {
          return;
        }

        const txHash = event.log.transactionHash;
        const tier = getTier(usdValue);

        const message = `
${tier}

Someone just baked a serious slice:

💵 $${formatNum(usdValue, 2)} BUY
🍕 ${formatNum(pizzaBought, 0)} PIZZA bought
💰 ${formatNum(satoSpent, 4)} SATO spent
👤 Buyer: ${shortAddress(to)}

🔥 More SATO flowing into the Pizza economy.

📈 DexScreener:
${DEXSCREENER_URL}

🔎 Transaction:
https://etherscan.io/tx/${txHash}
`;

        await bot.sendMessage(
          CHAT_ID,
          message,
          {
            disable_web_page_preview: false,
          }
        );

        console.log(
          "Alert sent:",
          txHash,
          `$${usdValue.toFixed(2)}`
        );
      } catch (err) {
        console.error(
          "Swap handling error:",
          err
        );
      }
    }
  );
}

main().catch(console.error);
