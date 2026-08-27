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

const MIN_USD_BUY = 5;
const PRICE_CACHE_MS = 60_000;
const BLOCK_POLL_MS = 8_000;
const CONFIRMATIONS = 3;
const RESCAN_BLOCKS = 6;
const STARTUP_LOOKBACK_BLOCKS = 20;
const MAX_BLOCKS_PER_QUERY = 10;
const MAX_CONSECUTIVE_RPC_FAILURES = 5;
const MAX_PROCESSED_EVENTS = 10_000;

let cachedSatoUsdPrice = null;
let cachedPriceTime = 0;

let lastProcessedBlock = null;
let scanQueue = Promise.resolve();
let highestQueuedBlock = 0;
let consecutiveRpcFailures = 0;

const processedEvents = new Set();

if (!BOT_TOKEN || !CHAT_ID || !RPC_URL) {
  throw new Error(
    "Missing BOT_TOKEN, CHAT_ID or RPC_URL in environment variables"
  );
}

/* =========================================================
   PROVIDERS + TELEGRAM
========================================================= */

// WebSocket = fast notification that Ethereum has a new block.
const wsProvider = new ethers.WebSocketProvider(RPC_URL);

// HTTP = independent provider for actually reading blocks/logs.
//
// This lets us receive a WebSocket notification but retrieve
// the swap logs separately, rather than trusting one live
// subscription to do everything.
const HTTP_RPC_URL = RPC_URL
  .replace(/^wss:\/\//i, "https://")
  .replace(/^ws:\/\//i, "http://");

const readProvider = new ethers.JsonRpcProvider(
  HTTP_RPC_URL
);

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
  readProvider
);

const pizza = new ethers.Contract(
  PIZZA_TOKEN,
  erc20Abi,
  readProvider
);

const sato = new ethers.Contract(
  SATO_TOKEN,
  erc20Abi,
  readProvider
);

const swapTopic = ethers.id(
  "Swap(address,uint256,uint256,uint256,uint256,address)"
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
  const txHash =
    event.transactionHash;

  const logIndex =
    event.index ??
    event.logIndex ??
    0;

  return `${txHash}:${logIndex}`;
};

function rememberProcessedEvent(eventId) {
  processedEvents.add(eventId);

  // Stop this Set growing forever.
  if (
    processedEvents.size >
    MAX_PROCESSED_EVENTS
  ) {
    const oldest =
      processedEvents.values().next().value;

    processedEvents.delete(oldest);
  }
}

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

  console.log(
    "💲 Fetching SATO USD price..."
  );

  const response = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${SATO_TOKEN}`
  );

  if (!response.ok) {
    throw new Error(
      `DexScreener API error: ${response.status}`
    );
  }

  const data =
    await response.json();

  const pairs =
    data.pairs || [];

  const bestPair = pairs
    .filter(
      (p) =>
        p.chainId === "ethereum" &&
        Number(p.priceUsd) > 0
    )
    .sort(
      (a, b) =>
        Number(
          b.liquidity?.usd || 0
        ) -
        Number(
          a.liquidity?.usd || 0
        )
    )[0];

  if (!bestPair) {
    throw new Error(
      "Could not determine SATO USD price"
    );
  }

  cachedSatoUsdPrice =
    Number(bestPair.priceUsd);

  cachedPriceTime =
    now;

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

  /*
   * Because we deliberately rescan old blocks,
   * we need to stop the same transaction being
   * announced multiple times.
   */
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
    "Block:",
    event.blockNumber
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

  /* =========================================================
     IGNORE SELLS
  ========================================================= */

  if (
    pizzaBought <= 0 ||
    satoSpent <= 0
  ) {
    console.log(
      "⏭️ Ignored: not a PIZZA buy"
    );

    rememberProcessedEvent(
      eventId
    );

    console.log(
      "============================================"
    );

    return;
  }

  /* =========================================================
     USD VALUE
  ========================================================= */

  let satoUsdPrice;

  try {
    satoUsdPrice =
      await getSatoUsdPrice();
  } catch (error) {
    /*
     * Do NOT mark this event processed.
     *
     * If DexScreener temporarily fails,
     * throwing here prevents the scanner
     * from advancing past the block.
     *
     * The block will therefore be retried.
     */
    console.error(
      "❌ SATO PRICE ERROR:",
      error
    );

    throw error;
  }

  const usdValue =
    satoSpent *
    satoUsdPrice;

  if (
    !Number.isFinite(usdValue)
  ) {
    throw new Error(
      `Invalid USD value for ${txHash}`
    );
  }

  console.log(
    "💵 Estimated buy value:",
    `$${usdValue.toFixed(2)}`
  );

  /* =========================================================
     MINIMUM BUY FILTER
  ========================================================= */

  if (
    usdValue <
    MIN_USD_BUY
  ) {
    console.log(
      `⏭️ Ignored: below $${MIN_USD_BUY} minimum`
    );

    rememberProcessedEvent(
      eventId
    );

    console.log(
      "============================================"
    );

    return;
  }

  /* =========================================================
     BUILD TELEGRAM MESSAGE
  ========================================================= */

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

  /* =========================================================
     SEND TELEGRAM ALERT
  ========================================================= */

  await bot.sendMessage(
    CHAT_ID,
    message,
    {
      disable_web_page_preview:
        false,
    }
  );

  /*
   * Only mark it processed AFTER
   * Telegram confirms the message.
   */
  rememberProcessedEvent(
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
   FETCH RAW SWAP LOGS
========================================================= */

async function getSwapLogs(
  fromBlock,
  toBlock
) {
  return await readProvider.getLogs({
    address:
      PAIR_ADDRESS,

    topics: [
      swapTopic,
    ],

    fromBlock,
    toBlock,
  });
}

/* =========================================================
   PARSE RAW SWAP LOG
========================================================= */

function parseSwapLog(log) {
  const parsed =
    pair.interface.parseLog(log);

  if (!parsed) {
    return null;
  }

  return {
    args:
      parsed.args,

    transactionHash:
      log.transactionHash,

    blockNumber:
      log.blockNumber,

    index:
      log.index ??
      log.logIndex ??
      0,

    logIndex:
      log.index ??
      log.logIndex ??
      0,
  };
}

/* =========================================================
   SCAN CONFIRMED BLOCKS
========================================================= */

async function scanToBlock(
  latestBlock,
  token0,
  token1,
  pizzaDecimals,
  satoDecimals
) {
  if (lastProcessedBlock === null) {
    return;
  }

  // Stay 3 blocks behind the Ethereum tip.
  const safeBlock =
    latestBlock - CONFIRMATIONS;

  if (safeBlock < 0) {
    return;
  }

  if (safeBlock <= lastProcessedBlock) {
    return;
  }

  // Rescan previous blocks for reliability.
  let fromBlock = Math.max(
    0,
    lastProcessedBlock - RESCAN_BLOCKS + 1
  );

  while (fromBlock <= safeBlock) {

    // FREE RPC LIMIT:
    // Inclusive range of 10 blocks:
    // 100 -> 109 = 10 blocks.
    const toBlock = Math.min(
      fromBlock + 9,
      safeBlock
    );

    console.log(
      `🔎 Scanning CONFIRMED blocks ${fromBlock} -> ${toBlock}`
    );

    const logs =
      await readProvider.getLogs({
        address: PAIR_ADDRESS,
        topics: [swapTopic],
        fromBlock,
        toBlock,
      });

    console.log(
      `🔔 Found ${logs.length} raw swap log(s)`
    );

    for (const log of logs) {
      const event =
        parseSwapLog(log);

      if (!event) {
        console.log(
          "⏭️ Could not parse swap log"
        );
        continue;
      }

      await handleSwap(
        event,
        token0,
        token1,
        pizzaDecimals,
        satoDecimals
      );
    }

    // Only after this 10-block batch succeeds
    // do we move to the next batch.
    fromBlock = toBlock + 1;
  }

  lastProcessedBlock =
    safeBlock;

  console.log(
    "✅ Safely processed through block:",
    lastProcessedBlock
  );
}

/* =========================================================
   SERIALISE SCANS
========================================================= */

function queueScan(
  latestBlock,
  token0,
  token1,
  pizzaDecimals,
  satoDecimals
) {
  /*
   * Keep track of the newest block we've seen.
   *
   * If Ethereum produces another block while
   * we're still scanning, we don't lose it.
   */

  highestQueuedBlock =
    Math.max(
      highestQueuedBlock,
      latestBlock
    );

  scanQueue =
    scanQueue
      .then(
        async () => {
          const target =
            highestQueuedBlock;

          await scanToBlock(
            target,
            token0,
            token1,
            pizzaDecimals,
            satoDecimals
          );
        }
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
           * Do NOT advance lastProcessedBlock.
           *
           * The next WebSocket block OR HTTP
           * poll retries the range.
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

  /* =========================================================
     TEST BOTH RPC CONNECTIONS
  ========================================================= */

  const wsNetwork =
    await wsProvider.getNetwork();

  const readNetwork =
    await readProvider.getNetwork();

  if (
    wsNetwork.chainId !==
    readNetwork.chainId
  ) {
    throw new Error(
      "WebSocket RPC and HTTP RPC are on different chains"
    );
  }

  console.log(
    "🌐 Connected to chain:",
    wsNetwork.chainId.toString()
  );

  console.log(
    "🔌 WebSocket RPC ready"
  );

  console.log(
    "📡 HTTP log RPC ready"
  );

  /* =========================================================
     STARTING BLOCK
  ========================================================= */

  const startingBlock =
    await readProvider.getBlockNumber();

  /*
   * IMPORTANT:
   *
   * Do NOT start exactly at the current block.
   *
   * Look back 20 blocks so a Railway
   * restart/deployment cannot create a blind spot.
   */

  lastProcessedBlock =
    Math.max(
      0,
      startingBlock -
        STARTUP_LOOKBACK_BLOCKS
    );

  highestQueuedBlock =
    startingBlock;

  console.log(
    "⛓️ Current Ethereum block:",
    startingBlock
  );

  console.log(
    "↩️ Startup lookback begins after block:",
    lastProcessedBlock
  );

  /* =========================================================
     PAIR INFORMATION
  ========================================================= */

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

  const pizzaLower =
    PIZZA_TOKEN.toLowerCase();

  const satoLower =
    SATO_TOKEN.toLowerCase();

  /*
   * Fail immediately if PAIR_ADDRESS
   * somehow isn't PIZZA/SATO.
   */

  const correctPair =
    (
      token0 === pizzaLower &&
      token1 === satoLower
    ) ||
    (
      token0 === satoLower &&
      token1 === pizzaLower
    );

  if (!correctPair) {
    throw new Error(
      `PAIR_ADDRESS is not PIZZA/SATO. token0=${token0} token1=${token1}`
    );
  }

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
    "🛡️ Confirmations:",
    CONFIRMATIONS
  );

  console.log(
    "🔁 Rescan overlap:",
    `${RESCAN_BLOCKS} blocks`
  );

  console.log(
    "🛟 Startup lookback:",
    `${STARTUP_LOOKBACK_BLOCKS} blocks`
  );

  /* =========================================================
     WEBSOCKET BLOCK NOTIFICATIONS
  ========================================================= */

  wsProvider.on(
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
     WEBSOCKET ERRORS
  ========================================================= */

  wsProvider.on(
    "error",
    (error) => {
      console.error(
        "❌ WEBSOCKET PROVIDER ERROR:",
        error
      );
    }
  );

  /* =========================================================
     INDEPENDENT HTTP BACKUP POLL
  ========================================================= */

  /*
   * Every 8 seconds we independently ask Ethereum:
   *
   * "What is the latest block?"
   *
   * Therefore even if the WebSocket silently stops
   * delivering block events, the bot keeps scanning.
   */

  setInterval(
    async () => {
      try {
        const latestBlock =
          await readProvider.getBlockNumber();

        consecutiveRpcFailures =
          0;

        queueScan(
          latestBlock,
          token0,
          token1,
          pizzaDecimals,
          satoDecimals
        );
      } catch (error) {
        consecutiveRpcFailures +=
          1;

        console.error(
          `❌ HTTP RPC POLL ERROR (${consecutiveRpcFailures}/${MAX_CONSECUTIVE_RPC_FAILURES}):`,
          error
        );

        /*
         * Don't leave a zombie Railway process
         * running indefinitely.
         *
         * After repeated RPC failures, exit.
         * Railway can then restart the bot.
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

  /* =========================================================
     IMMEDIATE STARTUP CATCH-UP
  ========================================================= */

  /*
   * Don't wait for the next Ethereum block.
   *
   * Immediately scan the startup lookback range.
   */

  queueScan(
    startingBlock,
    token0,
    token1,
    pizzaDecimals,
    satoDecimals
  );

  console.log("");

  console.log(
    "👂 Confirmed-block scanner registered."
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
