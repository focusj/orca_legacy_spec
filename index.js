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

async function searchPoolForTokenAB(tokenMintA, tokenMintB) {
    const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=637cde60-2fbe-44c9-9395-cfbdfb43e248', 'confirmed'); // 替换为你的连接
    const wallet = new Wallet(Keypair.generate()); // 替换为你的钱包对象
    const opts = {commitment: 'confirmed'}; // 可选的选项

    // 初始化 AnchorProvider
    const provider = new AnchorProvider(connection, wallet, opts);
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);

    const [mintA, mintB] = sortMintAB(tokenMintA, tokenMintB);

    const addrs = tickSpacingSet.map(ts => {
        return PDAUtil.getWhirlpool(
            ORCA_WHIRLPOOL_PROGRAM_ID,
            WHIRLPOOLS_CONFIG,
            mintA, mintB, ts).publicKey;
    });
    const pools = await client.getPools(addrs);

    return pools
        .filter(pool => !pool.getData().liquidity.isZero())
        .sort((poolA, poolB) => {
            return poolB.getData().liquidity.gt(poolA.getData().liquidity);
        });
}

async function quoteSinglePool() {
    // Create WhirlpoolClient
    const provider = AnchorProvider.env();
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);

    console.log("endpoint:", ctx.connection.rpcEndpoint);
    console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());

    const mintSol = new PublicKey("So11111111111111111111111111111111111111112");
    const mintBonk = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")

    const [mintA, mintB] = sortMintAB(mintSol, mintBonk);
    console.log(mintA, mintB);

    const devSol = {mint: mintSol, decimals: 6};
    const devBonk = {mint: mintBonk, decimals: 6};

    // Get devSAMO/devUSDC whirlpool
    // Whirlpools are identified by 5 elements (Program, Config, mint address of the 1st token,
    // mint address of the 2nd token, tick spacing), similar to the 5 column compound primary key in DB
    const tick_spacing = 64;
    const whirlpool_pubkey = PDAUtil.getWhirlpool(
        ORCA_WHIRLPOOL_PROGRAM_ID,
        WHIRLPOOLS_CONFIG,
        mintA, mintB, tick_spacing).publicKey;
    console.log("whirlpool_key:", whirlpool_pubkey.toBase58());

    const whirlpool = await client.getPool(whirlpool_pubkey);

    // Swap 1 devUSDC for devSAMO
    const amount_in = new Decimal("1" /* devUSDC */);

    // Obtain swap estimation (run simulation)
    const quote = await swapQuoteByInputToken(
        whirlpool,
        // Input token and amount
        devSol.mint,
        DecimalUtil.toBN(amount_in, devSol.decimals),
        // Acceptable slippage (10/1000 = 1%)
        Percentage.fromFraction(10, 1000),
        ctx.program.programId,
        ctx.fetcher,
        IGNORE_CACHE,
    );

    // Output the estimation
    console.log("estimatedAmountIn:", DecimalUtil.fromBN(quote.estimatedAmountIn, devSol.decimals).toString(), "devUSDC");
    console.log("estimatedAmountOut:", DecimalUtil.fromBN(quote.estimatedAmountOut, devBonk.decimals).toString(), "devSAMO");
    console.log("otherAmountThreshold:", DecimalUtil.fromBN(quote.otherAmountThreshold, devBonk.decimals).toString(), "devSAMO");
}

async function quoteWithRouter(mintA, mintB) {
    // You can use the Lookup Table Fetcher to find ALTs for V0 transactions
    // The Lookup Table Fetcher provided by Orca is not available on devnet, so set it to undefined
    // On mainnet, you can create a Lookup Table Fetcher with the following code
    // import { OrcaLookupTableFetcher } from "@orca-so/orca-sdk";
    // import axios from "axios";
    // 初始化 AnchorProvider
    const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=637cde60-2fbe-44c9-9395-cfbdfb43e248', 'confirmed'); // 替换为你的连接
    const wallet = new Wallet(Keypair.generate()); // 替换为你的钱包对象
    const opts = {commitment: 'confirmed'}; // 可选的选项
    const provider = new AnchorProvider(connection, wallet, opts);
    const server = axios.create({baseURL: "https://api.mainnet.orca.so/v1", responseType: "json"});
    const lookupTableFetcher = new OrcaLookupTableFetcher(server, provider.connection);
    // const lookupTableFetcher = undefined;

    // Create WhirlpoolClient
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID, undefined, lookupTableFetcher);
    const client = buildWhirlpoolClient(ctx);

    console.log("endpoint:", ctx.connection.rpcEndpoint);
    console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());

    // Token definition
    // devToken specification
    // https://everlastingsong.github.io/nebula/
    const devSol = {mint: mintA, decimals: 9};
    const devBonk = {mint: mintB, decimals: 5};

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

    // Create router
    const router = await client.getRouter(addresses);

    // Trade 100 devSAMO for devTMAC
    const trade = {
        tokenIn: devSol.mint,
        tokenOut: devBonk.mint,
        amountSpecifiedIsInput: true, // we specify devSAMO input amount
        tradeAmount: DecimalUtil.toBN(new Decimal("100"), devSol.decimals),
    };

    // Specify the options to be used to generate the route
    const routingOptions = {
        ...RouterUtils.getDefaultRouteOptions(),
        maxSplits: 1,
        // Specify the number of splits in the route and the rate of change of the allocation assigned to each route
    };
    const selectionOptions = {
        ...RouterUtils.getDefaultSelectOptions(),
        // Specify whether to support V0 transactions. The default is true
        maxSupportedTransactionVersion: ctx.txBuilderOpts.defaultBuildOption.maxSupportedTransactionVersion,
        // Provide the created ATA (fetch from the chain if undefined)
        // If you do the same process many times, you can improve performance by specifying a list of created ATAs
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

        if (!bestRoute) {
            console.log("No route found");
            return;
        }

        // Display details of the route obtained
        // In this tutorial, we expect devSAMO to be traded for devTMAC via the devSAMO/devUSDC and devTMAC/devUSDC pools
        // devSAMO/devUSDC: EgxU92G34jw6QDG9RuTX9StFg1PmHuDqkRKAE5kVEiZ4
        // devTMAC/devUSDC: H3xhLrSEyDFm6jjG42QezbvhSxF5YHW75VdGUnqeEg5y
        const [tradeRoute, alts] = bestRoute;
        console.log("estimatedAmountIn:", DecimalUtil.fromBN(tradeRoute.totalAmountIn, devSol.decimals));
        console.log("estimatedAmountOut:", DecimalUtil.fromBN(tradeRoute.totalAmountOut, devBonk.decimals));
        tradeRoute.subRoutes.forEach((subRoute, i) => {
            console.log(`subRoute[${i}] ${subRoute.splitPercent}%:`, subRoute.path.edges.map((e) => e.poolAddress).join(" - "));
        });
        console.log("alts:", alts?.map((a) => a.key.toBase58()).join(", "));
    } catch (e) {
        console.error(e);
    }
}


(async () => {
    const mintA = new PublicKey("So11111111111111111111111111111111111111112");
    const mintB = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")

    //await quoteSinglePool();
    await quoteWithRouter();

    //await searchPoolForTokenAB(mintA, mintB);
})()