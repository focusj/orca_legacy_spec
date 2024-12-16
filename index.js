const {PublicKey, Connection, Keypair} = require("@solana/web3.js");
const {AnchorProvider, Wallet} = require("@coral-xyz/anchor");
const {DecimalUtil, Percentage} = require("@orca-so/common-sdk");
const {
    WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID,
    PDAUtil, swapQuoteByInputToken, IGNORE_CACHE,
    getAllWhirlpoolAccountsForConfig, Trade,
    RoutingOptions, RouterUtils, RouteSelectOptions
} = require("@orca-so/whirlpools-sdk");
const Decimal = require("decimal.js");

const {OrcaLookupTableFetcher} = require("@orca-so/orca-sdk");
const axios = require("axios");
const {WhirlpoolAccountFetchOptions} = require("@orca-so/whirlpools-sdk/dist/network/public/fetcher");

const tickSpacingSet = [1, 2, 4, 8, 16, 64, 96, 128, 256, 32896]

// WhirlpoolsConfig account
// devToken ecosystem / Orca Whirlpools
const WHIRLPOOLS_CONFIG = new PublicKey("2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ");


// Environment variables must be defined before script execution
// ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
// ANCHOR_WALLET=wallet.json

function sortMintAB(mintA, mintB) {
    const buffer1 = mintA.toBuffer();
    const buffer2 = mintB.toBuffer();

    if (buffer1 > buffer2) {
        return [mintB, mintA];
    }

    return [mintA, mintB];
}

async function searchPoolForTokenAB(whirlpoolClient, tokenMintA, tokenMintB) {
    const [mintA, mintB] = sortMintAB(tokenMintA.mint, tokenMintB.mint);

    const addrs = tickSpacingSet.map(ts => {
        return PDAUtil.getWhirlpool(
            ORCA_WHIRLPOOL_PROGRAM_ID,
            WHIRLPOOLS_CONFIG,
            mintA, mintB, ts).publicKey;
    });
    const pools = await whirlpoolClient.getPools(addrs);
    const liquidPools = pools
        .filter(pool => !pool.getData().liquidity.isZero())
        .sort((poolA, poolB) => {
            return poolB.getData().liquidity.gt(poolA.getData().liquidity);
        });

    console.log("found liquid pools, tokenA:%j, tokenB:%j, pools:%j", mintA, mintB, liquidPools.map(pool => pool.getAddress()));

    return liquidPools;

}

async function quoteSinglePool(whirlpoolClient, pool, inputToken, amountIn, slippage) {
    console.log("quoting for single pool, pool:%j, inputToken:%j, amountIn:%j, slippage:%j", pool.getAddress(), inputToken, amountIn, slippage);

    const ctx = whirlpoolClient.ctx;
    const tokenAmount = DecimalUtil.toBN(new Decimal(amountIn), inputToken.decimals);

    try {
        const quote = await swapQuoteByInputToken(
            pool,
            inputToken.mint,
            tokenAmount,
            slippage,
            ctx.program.programId,
            ctx.fetcher,
            IGNORE_CACHE,
        );
        return quote;
    } catch (e) {
        return null;
    }
}

async function quoteWithRouter(tokenA, tokenB, amountIn) {
    const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=637cde60-2fbe-44c9-9395-cfbdfb43e248', 'confirmed'); // 替换为你的连接
    const wallet = new Wallet(Keypair.generate()); // 替换为你的钱包对象
    const opts = {commitment: 'confirmed'}; // 可选的选项
    const provider = new AnchorProvider(connection, wallet, opts);
    const server = axios.create({baseURL: "https://api.mainnet.orca.so/v1", responseType: "json"});
    const lookupTableFetcher = new OrcaLookupTableFetcher(server, provider.connection);

    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID, undefined, lookupTableFetcher);
    const client = buildWhirlpoolClient(ctx);

    console.log("endpoint:", ctx.connection.rpcEndpoint);
    console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());

    // Get all pools belonging to DEVNET_WHIRLPOOLS_CONFIG
    const devWhirlpools = await getAllWhirlpoolAccountsForConfig({
        connection: ctx.connection,
        programId: ctx.program.programId,
        configId: WHIRLPOOLS_CONFIG,
    });

    console.log("detected whirlpools:", devWhirlpools.size);

    // Exclude pools with current liquidity of 0 (to improve performance)
    const addresses = Array.from(devWhirlpools.entries())
        .filter(([_address, data]) => !data.liquidity.isZero())
        .map(([address, _data]) => address);
    console.log("liquid whirlpools", addresses.length);

    const router = await client.getRouter(addresses);

    const trade = {
        tokenIn: tokenA.mint,
        tokenOut: tokenB.mint,
        amountSpecifiedIsInput: true,
        tradeAmount: DecimalUtil.toBN(new Decimal(amountIn), tokenA.decimals),
    };

    const routingOptions = {
        ...RouterUtils.getDefaultRouteOptions(),
        maxSplits: 1,
    };
    const selectionOptions = {
        ...RouterUtils.getDefaultSelectOptions(),
        maxSupportedTransactionVersion: ctx.txBuilderOpts.defaultBuildOption.maxSupportedTransactionVersion,
        availableAtaAccounts: undefined,
    };

    try {
        // Get the best route
        const bestRoute = await router.findBestRoute(
            trade,
            routingOptions,
            selectionOptions,
            IGNORE_CACHE,
        );

        return bestRoute;
    } catch (e) {
        console.error(e);
    }
}


(async () => {
    const mintA = new PublicKey("So11111111111111111111111111111111111111112");
    const mintB = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")

    const tokenA = {mint: mintA, decimals: 9};
    const tokenB = {mint: mintB, decimals: 5};

    //3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1
    // const bestRoute = await quoteWithRouter(mintA, mintB);
    // const [tradeRoute, alts] = bestRoute;
    // console.log("estimatedAmountIn:", DecimalUtil.fromBN(tradeRoute.totalAmountIn, tokenA.decimals));
    // console.log("estimatedAmountOut:", DecimalUtil.fromBN(tradeRoute.totalAmountOut, tokenB.decimals));
    // tradeRoute.subRoutes.forEach((subRoute, i) => {
    //     console.log(`subRoute[${i}] ${subRoute.splitPercent}%:`, subRoute.path.edges.map((e) => e.poolAddress).join(" - "));
    // });
    // console.log("alts:", alts?.map((a) => a.key.toBase58()).join(", "));


    const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=637cde60-2fbe-44c9-9395-cfbdfb43e248', 'confirmed'); // 替换为你的连接
    const wallet = new Wallet(Keypair.generate()); // 替换为你的钱包对象
    const opts = {commitment: 'confirmed'}; // 可选的选项

    // 初始化 AnchorProvider
    const provider = new AnchorProvider(connection, wallet, opts);
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const whirlpoolClient = buildWhirlpoolClient(ctx);

    const pools = await searchPoolForTokenAB(whirlpoolClient, tokenA, tokenB);
    console.log(pools[0].getAddress());

    for (const pool of pools) {
        const slippage = Percentage.fromFraction(10, 1000)
        const quote = await quoteSinglePool(whirlpoolClient, pool, tokenA, 100, slippage);
        if (!quote) {
            console.log("quoting failed, pool:%j, inputToken:%j, amountIn:%j, slippage:%j", pool.getAddress(), tokenA, 100, slippage);
            continue;
        }
        console.log("estimatedAmountIn:", DecimalUtil.fromBN(quote.estimatedAmountIn, tokenA.decimals).toString(), "Sol");
        console.log("estimatedAmountOut:", DecimalUtil.fromBN(quote.estimatedAmountOut, tokenB.decimals).toString(), "Bonk");
        console.log("otherAmountThreshold:", DecimalUtil.fromBN(quote.otherAmountThreshold, tokenB.decimals).toString(), "Bonk");
    }
})()