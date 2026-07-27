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

const MIN_PIZZA_BUY = 1000;

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

const erc20Abi = ["function decimals() view returns (uint8)"];

const pair = new ethers.Contract(PAIR_ADDRESS, pairAbi, provider);
const pizza = new ethers.Contract(PIZZA_TOKEN, erc20Abi, provider);
const sato = new ethers.Contract(SATO_TOKEN, erc20Abi, provider);

const shortAddress = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

const formatNum = (num, maxDecimals = 2) =>
  Number(num).toLocaleString("en-US", {
    maximumFractionDigits: maxDecimals,
  });

const getTier = (pizzaBought) => {
  if (pizzaBought >= 100000) return "👑🍕 PIZZA LEGEND ALERT";
  if (pizzaBought >= 25000) return "🐋🍕 PIZZA WHALE ALERT";
  if (pizzaBought >= 10000) return "🦈🍕 PIZZA SHARK ALERT";
  return "🍕🔥 FRESH PIZZA BUY";
};

async function main() {
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();

  const pizzaDecimals = await pizza.decimals();
  const satoDecimals = await sato.decimals();

  console.log("🍕 Pizza Whale Alert bot running...");
  console.log("Watching pair:", PAIR_ADDRESS);
  console.log("Minimum alert:", MIN_PIZZA_BUY, "PIZZA");

  pair.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
    try {
      let pizzaBought = 0;
      let satoSpent = 0;

      if (token0 === PIZZA_TOKEN.toLowerCase()) {
        pizzaBought = Number(ethers.formatUnits(amount0Out, pizzaDecimals));
        satoSpent = Number(ethers.formatUnits(amount1In, satoDecimals));
      }

      if (token1 === PIZZA_TOKEN.toLowerCase()) {
        pizzaBought = Number(ethers.formatUnits(amount1Out, pizzaDecimals));
        satoSpent = Number(ethers.formatUnits(amount0In, satoDecimals));
      }

      if (pizzaBought < MIN_PIZZA_BUY) return;

      const txHash = event.log.transactionHash;
      const tier = getTier(pizzaBought);

      const message = `
${tier}

Someone just baked a serious slice:

🍕 ${formatNum(pizzaBought, 0)} PIZZA bought
💰 ${formatNum(satoSpent, 4)} SATO spent
👤 Buyer: ${shortAddress(to)}

🔥 More SATO flowing into the Pizza economy.

📈 DexScreener:
${DEXSCREENER_URL}

🔎 Transaction:
https://etherscan.io/tx/${txHash}
`;

      await bot.sendMessage(CHAT_ID, message, {
        disable_web_page_preview: false,
      });

      console.log("Alert sent:", txHash);
    } catch (err) {
      console.error("Swap handling error:", err);
    }
  });
}

main().catch(console.error);
