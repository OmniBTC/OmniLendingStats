import {SuiContext, SuiNetwork} from "@sentio/sdk/sui";
import {pool} from "./types/sui/0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb.js";
import {CLMM_MAINNET, LENDING, SWAP} from "./helper/address.js";
import {calculateSwapVol_USD, getOrCreatePool} from "./helper/swap.js";
import {lending_logic, user_manager} from "./types/sui/omnilending.js";
import {
    CALL_TYPE_TO_NAME,
    convertToAddress,
    LENDING_DECIMALS,
    POOL_ID_TO_SYMBOL,
    POOL_ID_TO_USER_COLLATERAL,
    RAY,
} from "./helper/lending.js";
import {getPriceBySymbol} from "@sentio/sdk/utils";

export interface TreasuryInfo {
    dola_pool_id: number;
    amount: number;
    value: number;
}

async function queryTreasuryFee(
    ctx: SuiContext,
    dola_pool_id: number
): Promise<TreasuryInfo> {
    let data = await ctx.client.dryRunTransactionBlock(POOL_ID_TO_USER_COLLATERAL[dola_pool_id]);
    return {
        dola_pool_id,
        amount: data.events[0].parsedJson.collateral_amount,
        value: data.events[0].parsedJson.collateral_value
    };
}

pool
    .bind({
        address: CLMM_MAINNET,
        network: SuiNetwork.MAIN_NET,
    })
    .onEventSwapEvent(async (event, ctx) => {
        if (ctx.transaction.events?.[0].packageId == SWAP) {
            console.log("Add OmniSwap Event:", ctx.transaction.digest)
            ctx.meter.Counter("swap_counter").add(1, {project: "omniswap"});
            const pool = event.data_decoded.pool;
            const poolInfo = await getOrCreatePool(ctx, pool);
            const symbol_a = poolInfo.symbol_a;
            const symbol_b = poolInfo.symbol_b;
            const atob = event.data_decoded.atob;
            const decimal_a = poolInfo.decimal_a;
            const decimal_b = poolInfo.decimal_b;
            const pairName = poolInfo.pairName;
            const amount_in =
                Number(event.data_decoded.amount_in) /
                Math.pow(10, atob ? decimal_a : decimal_b);
            const amount_out =
                Number(event.data_decoded.amount_out) /
                Math.pow(10, atob ? decimal_b : decimal_a);

            const usd_volume = await calculateSwapVol_USD(
                poolInfo.type,
                amount_in,
                amount_out,
                atob,
                ctx.timestamp
            );

            ctx.eventLogger.emit("SwapEvent", {
                project: "omniswap",
                distinctId: ctx.transaction.transaction.data.sender,
                pool,
                amount_in,
                amount_out,
                usd_volume,
                pairName,
                message: `Swap ${amount_in} ${
                    atob ? symbol_a : symbol_b
                } to ${amount_out} ${
                    atob ? symbol_b : symbol_a
                }. USD value: ${usd_volume} in Pool ${pairName} `,
            });

            ctx.meter
                .Gauge("swap_vol_gauge")
                .record(usd_volume, {pairName, project: "omniswap"});
            ctx.meter
                .Counter("swap_vol_counter")
                .add(usd_volume, {pairName, project: "omniswap"});
        }
    });

lending_logic
    .bind({
        address: LENDING,
        network: SuiNetwork.MAIN_NET,
    })
    .onEventLendingCoreExecuteEvent(async (event, ctx) => {
        ctx.meter.Counter("lending_counter").add(1, {project: "omnilending"});

        const call_type = event.data_decoded.call_type;
        const pool_id = event.data_decoded.pool_id;
        try {
            let symbol = POOL_ID_TO_SYMBOL.get(pool_id) as string;
            const price = await getPriceBySymbol(symbol, ctx.timestamp);
            if (pool_id === 8) {
                symbol = "whUSDCeth"
            }
            let treasury_amount = 0;
            let treasury_fee = 0;

            try {
                let treasury_info = await queryTreasuryFee(
                    ctx,
                    pool_id
                )
                treasury_amount = treasury_info.amount / Math.pow(10, LENDING_DECIMALS);
                treasury_fee = treasury_info.value / Math.pow(10, LENDING_DECIMALS);
            } catch (e) {
                console.log("query treasury warning:", e)
            }
            const amount = Number(event.data_decoded.amount) / Math.pow(10, LENDING_DECIMALS);
            const user_id = event.data_decoded.user_id;
            const value = amount * Number(price);
            const call_name = CALL_TYPE_TO_NAME.get(call_type) as string;

            if (call_type == 0) {
                ctx.meter
                    .Counter("lending_tvl_counter")
                    .add(value, {token: symbol, project: "omnilending"});
            }

            if (call_type == 1) {
                ctx.meter
                    .Counter("lending_tvl_counter")
                    .sub(value, {token: symbol, project: "omnilending"});
            }

            const adapter_event = ctx.transaction.events.find(
                (event: { type: any }) =>
                    event.type ==
                    "0x826915f8ca6d11597dfe6599b8aa02a4c08bd8d39674855254a06ee83fe7220e::lending_core_wormhole_adapter::LendingCoreEvent"
            );

            let receiver;
            let address_type;
            let src_chain_id;
            let dst_chain_id;
            if (adapter_event !== undefined) {
                receiver = convertToAddress(adapter_event.parsedJson.receiver);
                if (adapter_event.parsedJson.dst_chain_id === 0) {
                    address_type = "sui:"
                } else {
                    address_type = "evm:"
                }
                src_chain_id = adapter_event.parsedJson.source_chain_id;
                dst_chain_id = adapter_event.parsedJson.dst_chain_id;
            } else {
                receiver = ctx.transaction.transaction.data.sender;
                src_chain_id = 0;
                dst_chain_id = 0;
                address_type = "sui:"
            }


            ctx.eventLogger.emit("LendingEvent", {
                project: "omnilending",
                distinctId: address_type + receiver,
                user_id,
                call_name,
                symbol,
                amount,
                value,
                src_chain_id,
                dst_chain_id,
                message: `User ${user_id} ${call_name} ${amount} ${symbol} with value ${value} USD`,
            });

            // Reserve stats event
            const reserve_stats_events = ctx.transaction.events.filter(
                (event: { type: any }) =>
                    event.type ==
                    "0x826915f8ca6d11597dfe6599b8aa02a4c08bd8d39674855254a06ee83fe7220e::lending_logic::LendingReserveStatsEvent"
            );

            for (const reserve_stats_event of reserve_stats_events) {
                const otoken_amount = reserve_stats_event.parsedJson.otoken_scaled_amount * reserve_stats_event.parsedJson.supply_index / Math.pow(10, RAY + LENDING_DECIMALS);
                const dtoken_amount = reserve_stats_event.parsedJson.dtoken_scaled_amount * reserve_stats_event.parsedJson.borrow_index / Math.pow(10, RAY + LENDING_DECIMALS);
                const pool_id = reserve_stats_event.parsedJson.pool_id;
                let symbol = POOL_ID_TO_SYMBOL.get(pool_id) as string;
                if (pool_id === 8) {
                    symbol = "whUSDCeth"
                }
                let otoken_value;
                let dtoken_value;
                if (price === undefined) {
                    otoken_value = 0;
                    dtoken_value = 0;
                } else {
                    otoken_value = otoken_amount * price;
                    dtoken_value = dtoken_amount * price;
                }

                const borrow_rate = reserve_stats_event.parsedJson.borrow_rate / Math.pow(10, RAY);
                const supply_rate = reserve_stats_event.parsedJson.supply_rate / Math.pow(10, RAY);

                ctx.eventLogger.emit("LendReserve", {
                    project: "omnilending",
                    distinctId: address_type + receiver,
                    otoken_amount,
                    otoken_value,
                    dtoken_amount,
                    dtoken_value,
                    borrow_rate,
                    supply_rate,
                    call_name,
                    symbol,
                    treasury_amount,
                    treasury_fee,
                    message: `Reserve ${symbol} update by ${call_name}`,
                });
            }

            // User stats event

            const user_stats_events = ctx.transaction.events.filter(
                (event: { type: any, parsedJson: any }) =>
                    event.type ==
                    "0x826915f8ca6d11597dfe6599b8aa02a4c08bd8d39674855254a06ee83fe7220e::lending_logic::LendingUserStatsEvent"
            );

            for (const user_stats_event of user_stats_events) {
                const user_id = Number(user_stats_event.parsedJson.user_id)
                const pool_id = user_stats_event.parsedJson.pool_id;
                let symbol = POOL_ID_TO_SYMBOL.get(pool_id) as string;
                if (pool_id === 8) {
                    symbol = "whUSDCeth"
                }
                ctx.eventLogger.emit("LendUser", {
                    project: "omnilending",
                    distinctId: address_type + receiver,
                    user_id,
                    otoken_scaled_amount: user_stats_event.parsedJson.otoken_scaled_amount,
                    dtoken_scaled_amount: user_stats_event.parsedJson.dtoken_scaled_amount,
                    call_name,
                    symbol,
                    message: `User ${user_id} ${symbol} update by ${call_name}`,
                });
            }
        } catch (e) {
            console.log("warning:", e)
        }

    });

user_manager
    .bind({
        address: LENDING,
        network: SuiNetwork.MAIN_NET,
    })
    .onEventBindUser(async (event, ctx) => {
        console.log("Add Lending Event:", ctx.transaction.digest)
        ctx.meter.Counter("lending_counter").add(1, {project: "omnilending"});
    })
    .onEventUnbindUser(async (event, ctx) => {
        console.log("Add Lending Event:", ctx.transaction.digest)
        ctx.meter.Counter("lending_counter").add(1, {project: "omnilending"});
    });
