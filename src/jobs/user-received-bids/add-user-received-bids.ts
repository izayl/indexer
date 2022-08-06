import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { redis } from "@/common/redis";
import { config } from "@/config/index";
import { logger } from "@/common/logger";
import { idb } from "@/common/db";
import { fromBuffer, toBuffer } from "@/common/utils";

const QUEUE_NAME = "add-user-received-bids-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 100,
    removeOnFail: 100,
    timeout: 60 * 1000,
  },
});

new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

export const BATCH_SIZE = 500;

if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { orderId, contract, tokenId } = job.data as AddUserReceivedBidsParams;

      let continuationFilter = "";

      if (contract && tokenId) {
        continuationFilter = `AND (contract, token_id) > ($/contract/, $/tokenId/)`;
      }

      const order = await idb.oneOrNone(
        `
              SELECT
                orders.id,
                orders.token_set_id,
                orders.maker,
                orders.price,
                orders.value,
                orders.quantity_remaining,
                orders.valid_between,
                orders.expiration,
                orders.created_at
              FROM orders
              WHERE orders.id = $/orderId/
              LIMIT 1
            `,
        { orderId }
      );

      const query = `
        WITH "z" AS (
          SELECT
            "y"."owner" as "address",
            "x"."contract",
            "x"."token_id"
          FROM (
            SELECT "tst"."contract", "tst"."token_id"
            FROM "token_sets_tokens" "tst"
            WHERE "token_set_id" = $/tokenSetId/
            ${continuationFilter}
            ORDER BY contract, token_id ASC
            LIMIT ${BATCH_SIZE}
          ) "x" LEFT JOIN LATERAL (
            SELECT
              "nb"."owner"
            FROM "nft_balances" "nb"
            WHERE "nb"."contract" = "x"."contract"
              AND "nb"."token_id" = "x"."token_id"
              AND "nb"."amount" > 0
          ) "y" ON TRUE
        ), y AS (
          INSERT INTO "user_received_bids" (
            address,
            contract,
            token_id,
            order_id,
            order_created_at,
            maker,
            price,
            value,
            quantity,
            valid_between,
            clean_at
          )
          SELECT
            address,
            contract,
            max(token_id),
            $/orderId/,
            $/orderCreatedAt/::TIMESTAMPTZ,
            $/maker/::BYTEA AS maker,
            $/price/::NUMERIC(78, 0),
            $/value/::NUMERIC(78, 0),
            $/quantity/::NUMERIC(78, 0),
            $/validBetween/::TSTZRANGE,
            LEAST($/expiration/::TIMESTAMPTZ, now() + interval '24 hours')
          FROM z 
          WHERE "z"."address" IS NOT NULL 
          GROUP BY address, contract
          ON CONFLICT DO NOTHING
          RETURNING *
        )
        SELECT contract, token_id
        FROM y
        ORDER BY contract, token_id DESC
        LIMIT 1
      `;

      const result = await idb.oneOrNone(query, {
        tokenSetId: order.token_set_id,
        orderId: order.id,
        orderCreatedAt: order.created_at,
        maker: order.maker,
        price: order.price,
        value: order.value,
        quantity: order.quantity_remaining,
        validBetween: order.valid_between,
        expiration: order.expiration,
        contract: contract ? toBuffer(contract) : null,
        tokenId,
      });

      if (!order.token_set_id.startsWith("token:") && result) {
        await addToQueue([
          {
            orderId,
            contract: fromBuffer(result.contract),
            tokenId: result.token_id,
          },
        ]);
      }
    },
    {
      connection: redis.duplicate(),
      concurrency: 3,
    }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export type AddUserReceivedBidsParams = {
  orderId: string;
  contract?: string | null;
  tokenId?: string | null;
};

export const addToQueue = async (jobs: AddUserReceivedBidsParams[]) => {
  await queue.addBulk(
    jobs.map((job) => ({
      name: job.orderId,
      data: job,
    }))
  );
};