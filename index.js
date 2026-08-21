import "dotenv/config";
import { ethers } from "ethers";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL;

const PIZZA_TOKEN =
  "0x831A3962e31037cf4Eb8847cb7eA05aaC1Db35B6";

const SATO_TOKEN =
  "0x829f4B62EEBE12Af653b4dD4fFc480966F7d7f09";

const PAIR_ADDRESS =
  "0x390B5EADf8192840b784228E5c712f298c7c2DC8";

const DEXSCREENER_URL =
  "https://dexscreener.com/ethereum/0x390B5EADf8192840b784228E5c712f298c7c2DC8";

// Minimum USD value required to trigger an alert
const MIN_USD_BUY = 5;

// Cache SATO price for 60 seconds
const PRICE_CACHE_MS = 60_000;

// Backup check in case a WebSocket block notification is missed
const BLOCK_POLL_MS = 10_000;

// Keep eth_getLogs requests small if the bot needs to catch up
const MAX_BLOCKS_PER_QUERY = 100;

// If RPC repeatedly dies, exit so Railway can restart the service
const MAX_CONSECUTIVE_RPC_FAILURES = 5;

let cachedSatoUsdPrice = null;
let cachedPriceTime = 0;

let lastProcessedBlock = null;
let scanQueue = Promise.resolve();
let consecutiveRpcFailures = 0;

// Prevent duplicate alerts while this process is running
const processedEvents = new Set();

if (!BOT_TOKEN || !CHAT_ID || !RPC_URL) {
  throw new Error(
    "Missing BOT_TOKEN, CHAT_ID or RPC_URL in environment variables"
  );
}

/* =========================================================
   PROVIDER + TELEGRAM
========================================================= */

const provider = new ethers.WebSocketProvider(RPC_URL);

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
});

/* =========================================================
   ABIs
========================================================= */

const pairAbi = [
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const erc20Abi = [
  "function decimals() view returns (uint8)",
];

/* =========================================================
   CONTRACTS
========================================================= */

const pair = new ethers.Contract(
  PAIR_ADDRESS,
  pairAbi,
  provider
);

const pizza = new ethers.Contract(
  PIZZA_TOKEN,
  erc20Abi,
  provider
);

const sato = new ethers.Contract(
  SATO_TOKEN,
  erc20Abi,
  provider
);

/* =========================================================
   HELPERS
========================================================= */

const shortAddress = (addr) =>
  `${addr.slice(0, 6)}...${addr.slice(-4)}`;

const formatNum = (num, maxDecimals = 2) =>
  Number(num).toLocaleString("en-US", {
    maximumFractionDigits: maxDecimals,
  });

const getTier = (usdValue) => {
  if (usdValue >= 500) {
    return "👑🍕 PIZZA LEGEND ALERT";
  }

  if (usdValue >= 100) {
    return "🐋🍕 PIZZA WHALE ALERT";
  }

  if (usdValue >= 25) {
    return "🦈🍕 PIZZA SHARK ALERT";
  }

  return "🍕🔥 FRESH PIZZA BUY";
};

const getEventId = (event) => {
  const txHash = event.transactionHash;

  const logIndex =
    event.index ??
    event.logIndex ??
    0;

  return `${txHash}:${logIndex}`;
};

/* =========================================================
   SATO PRICE
========================================================= */

async function getSatoUsdPrice() {
  const now = Date.now();

  if (
    cachedSatoUsdPrice !== null &&
    now - cachedPriceTime < PRICE_CACHE_MS
  ) {
    return cachedSatoUsdPrice;
  }

  console.log("💲 Fetching SATO USD price...");

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
    throw new Error(
      "Could not determine SATO USD price"
    );
  }

  cachedSatoUsdPrice =
    Number(bestPair.priceUsd);

  cachedPriceTime = now;

  console.log(
    "💲 Updated SATO price:",
    `$${cachedSatoUsdPrice}`
  );

  return cachedSatoUsdPrice;
}

/* =========================================================
   HANDLE ONE SWAP
========================================================= */

async function handleSwap(
  event,
  token0,
  token1,
  pizzaDecimals,
  satoDecimals
) {
  const eventId =
    getEventId(event);

  if (
    processedEvents.has(eventId)
  ) {
    console.log(
      "⏭️ Already processed:",
      eventId
    );

    return;
  }

  const {
    sender,
    amount0In,
    amount1In,
    amount0Out,
    amount1Out,
    to,
  } = event.args;

  const txHash =
    event.transactionHash;

  console.log("");

  console.log(
    "============================================"
  );

  console.log(
    "🔔 SWAP FOUND"
  );

  console.log(
    "TX:",
    txHash
  );

  console.log(
    "Sender:",
    sender
  );

  console.log(
    "To:",
    to
  );

  console.log(
    "amount0In:",
    amount0In.toString()
  );

  console.log(
    "amount1In:",
    amount1In.toString()
  );

  console.log(
    "amount0Out:",
    amount0Out.toString()
  );

  console.log(
    "amount1Out:",
    amount1Out.toString()
  );

  let pizzaBought = 0;
  let satoSpent = 0;

  /* -----------------------------------------------------
     PIZZA = TOKEN0
  ----------------------------------------------------- */

  if (
    token0 ===
    PIZZA_TOKEN.toLowerCase()
  ) {
    pizzaBought =
      Number(
        ethers.formatUnits(
          amount0Out,
          pizzaDecimals
        )
      );

    satoSpent =
      Number(
        ethers.formatUnits(
          amount1In,
          satoDecimals
        )
      );
  }

  /* -----------------------------------------------------
     PIZZA = TOKEN1
  ----------------------------------------------------- */

  if (
    token1 ===
    PIZZA_TOKEN.toLowerCase()
  ) {
    pizzaBought =
      Number(
        ethers.formatUnits(
          amount1Out,
          pizzaDecimals
        )
      );

    satoSpent =
      Number(
        ethers.formatUnits(
          amount0In,
          satoDecimals
        )
      );
  }

  console.log(
    "🍕 PIZZA bought:",
    pizzaBought
  );

  console.log(
    "💰 SATO spent:",
    satoSpent
  );

  /* -----------------------------------------------------
     IGNORE SELLS
  ----------------------------------------------------- */

  if (
    pizzaBought <= 0 ||
    satoSpent <= 0
  ) {
    console.log(
      "⏭️ Ignored: not a PIZZA buy"
    );

    console.log(
      "============================================"
    );

    processedEvents.add(
      eventId
    );

    return;
  }

  /* -----------------------------------------------------
     GET USD VALUE
  ----------------------------------------------------- */

  const satoUsdPrice =
    await getSatoUsdPrice();

  const usdValue =
    satoSpent *
    satoUsdPrice;

  console.log(
    "💵 Estimated buy value:",
    `$${usdValue.toFixed(2)}`
  );

  /* -----------------------------------------------------
     MINIMUM BUY FILTER
  ----------------------------------------------------- */

  if (
    usdValue <
    MIN_USD_BUY
  ) {
    console.log(
      `⏭️ Ignored: below $${MIN_USD_BUY} minimum`
    );

    console.log(
      "============================================"
    );

    processedEvents.add(
      eventId
    );

    return;
  }

  /* -----------------------------------------------------
     BUILD TELEGRAM ALERT
  ----------------------------------------------------- */

  const tier =
    getTier(usdValue);

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

  /* -----------------------------------------------------
     SEND TELEGRAM MESSAGE
  ----------------------------------------------------- */

  await bot.sendMessage(
    CHAT_ID,
    message,
    {
      disable_web_page_preview:
        false,
    }
  );

  // Only mark the event as processed
  // after Telegram confirms the send.
  processedEvents.add(
    eventId
  );

  console.log(
    "🚨 TELEGRAM ALERT SENT"
  );

  console.log(
    "TX:",
    txHash
  );

  console.log(
    "Value:",
    `$${usdValue.toFixed(2)}`
  );

  console.log(
    "============================================"
  );
}

/* =========================================================
   SCAN BLOCKS FOR SWAPS
========================================================= */

async function scanToBlock(
  targetBlock,
  token0,
  token1,
  pizzaDecimals,
  satoDecimals
) {
  if (
    lastProcessedBlock === null
  ) {
    return;
  }

  if (
    targetBlock <=
    lastProcessedBlock
  ) {
    return;
  }

  while (
    lastProcessedBlock <
    targetBlock
  ) {
    const fromBlock =
      lastProcessedBlock + 1;

    const toBlock =
      Math.min(
        fromBlock +
          MAX_BLOCKS_PER_QUERY -
          1,
        targetBlock
      );

    console.log(
      `🔎 Scanning blocks ${fromBlock} -> ${toBlock}`
    );

    const events =
      await pair.queryFilter(
        pair.filters.Swap(),
        fromBlock,
        toBlock
      );

    console.log(
      `🔔 Found ${events.length} swap event(s)`
    );

    for (
      const event of events
    ) {
      await handleSwap(
        event,
        token0,
        token1,
        pizzaDecimals,
        satoDecimals
      );
    }

    /*
     * IMPORTANT:
     * Only advance after every event
     * in this block range was handled.
     *
     * If DexScreener, Telegram or the RPC
     * throws an error, this line is not reached.
     *
     * The next scan will therefore retry
     * the same missing block range.
     */

    lastProcessedBlock =
      toBlock;

    console.log(
      "✅ Processed through block:",
      lastProcessedBlock
    );
  }
}

/* =========================================================
   SERIALISE SCANS
========================================================= */

function queueScan(
  targetBlock,
  token0,
  token1,
  pizzaDecimals,
  satoDecimals
) {
  /*
   * Ethereum blocks can arrive while
   * the previous block is still being checked.
   *
   * The queue prevents two scans from
   * modifying lastProcessedBlock simultaneously.
   */

  scanQueue =
    scanQueue
      .then(() =>
        scanToBlock(
          targetBlock,
          token0,
          token1,
          pizzaDecimals,
          satoDecimals
        )
      )
      .catch(
        (error) => {
          console.error(
            "❌ BLOCK SCAN ERROR:",
            error
          );

          console.log(
            "ℹ️ Last successfully processed block:",
            lastProcessedBlock
          );

          /*
           * Do NOT move lastProcessedBlock.
           *
           * The next block event or
           * backup poll will retry it.
           */
        }
      );
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  console.log("");

  console.log(
    "============================================"
  );

  console.log(
    "🍕 PIZZA WHALE BOT STARTING"
  );

  console.log(
    "============================================"
  );

  /*
   * Confirm Ethereum connectivity
   */

  const network =
    await provider.getNetwork();

  console.log(
    "🌐 Connected to chain:",
    network.chainId.toString()
  );

  /*
   * Record where we are starting.
   *
   * We deliberately start at the current
   * block so an old buy is not announced
   * again when Railway redeploys.
   */

  const startingBlock =
    await provider.getBlockNumber();

  lastProcessedBlock =
    startingBlock;

  console.log(
    "⛓️ Current Ethereum block:",
    startingBlock
  );

  /* ---------------------------------------------------------
     PAIR INFORMATION
  --------------------------------------------------------- */

  const token0 =
    (
      await pair.token0()
    ).toLowerCase();

  const token1 =
    (
      await pair.token1()
    ).toLowerCase();

  const pizzaDecimals =
    await pizza.decimals();

  const satoDecimals =
    await sato.decimals();

  console.log("");

  console.log(
    "🍕 Pizza Whale Alert bot running..."
  );

  console.log(
    "👀 Watching pair:",
    PAIR_ADDRESS
  );

  console.log(
    "🪙 token0:",
    token0
  );

  console.log(
    "🪙 token1:",
    token1
  );

  console.log(
    "🍕 PIZZA decimals:",
    pizzaDecimals.toString()
  );

  console.log(
    "💰 SATO decimals:",
    satoDecimals.toString()
  );

  console.log(
    "🚨 Minimum alert:",
    `$${MIN_USD_BUY}`
  );

  console.log(
    "🧱 Starting after block:",
    lastProcessedBlock
  );

  /* =========================================================
     BLOCK HEARTBEAT + PRIMARY SCAN TRIGGER
  ========================================================= */

  provider.on(
    "block",
    (blockNumber) => {
      console.log(
        "❤️ Block received:",
        blockNumber
      );

      consecutiveRpcFailures =
        0;

      queueScan(
        blockNumber,
        token0,
        token1,
        pizzaDecimals,
        satoDecimals
      );
    }
  );

  /* =========================================================
     PROVIDER ERROR LOGGING
  ========================================================= */

  provider.on(
    "error",
    (error) => {
      console.error(
        "❌ PROVIDER ERROR:",
        error
      );
    }
  );

  /* =========================================================
     BACKUP BLOCK POLL

     Even if WebSocket gives us block 100
     and then skips straight to block 103,
     scanToBlock() will query:

     101
     102
     103

     The poll also checks Ethereum every
     10 seconds in case the block event
     itself is missed.
  ========================================================= */

  setInterval(
    async () => {
      try {
        const latestBlock =
          await provider.getBlockNumber();

        consecutiveRpcFailures =
          0;

        if (
          lastProcessedBlock !==
            null &&
          latestBlock >
            lastProcessedBlock
        ) {
          console.log(
            "🛟 Poll found unprocessed block(s). Latest:",
            latestBlock
          );

          queueScan(
            latestBlock,
            token0,
            token1,
            pizzaDecimals,
            satoDecimals
          );
        }
      } catch (error) {
        consecutiveRpcFailures +=
          1;

        console.error(
          `❌ RPC POLL ERROR (${consecutiveRpcFailures}/${MAX_CONSECUTIVE_RPC_FAILURES}):`,
          error
        );

        /*
         * If the WebSocket/RPC connection
         * has completely died, Railway
         * restarting us is safer than
         * leaving a zombie bot running.
         */

        if (
          consecutiveRpcFailures >=
          MAX_CONSECUTIVE_RPC_FAILURES
        ) {
          console.error(
            "💀 RPC has failed repeatedly. Exiting so Railway can restart the bot."
          );

          process.exit(1);
        }
      }
    },
    BLOCK_POLL_MS
  );

  console.log("");

  console.log(
    "👂 Block scanner registered."
  );

  console.log(
    "❤️ Waiting for Ethereum blocks..."
  );

  console.log("");
}

/* =========================================================
   FATAL ERRORS
========================================================= */

main().catch(
  (error) => {
    console.error(
      "❌ FATAL BOT ERROR:",
      error
    );

    process.exit(1);
  }
);
