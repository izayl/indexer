/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";
import _ from "lodash";

import { logger } from "@/common/logger";
import { Tokens } from "@/models/tokens";
import { ApiKeyManager } from "@/models/api-keys";

import { TokensEntityUpdateParams } from "@/models/tokens/tokens-entity";
import { Collections } from "@/models/collections";
import * as metadataIndexFetch from "@/jobs/metadata-index/fetch-queue";

const version = "v1";

export const postFlagTokenV1Options: RouteOptions = {
  description: "Update token flag status",
  tags: ["api", "Management"],
  plugins: {
    "hapi-swagger": {
      order: 13,
    },
  },
  validate: {
    payload: Joi.object({
      token: Joi.string()
        .lowercase()
        .pattern(/^0x[a-fA-F0-9]{40}:[0-9]+$/)
        .description(
          "The token to update the flag status for. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:123`"
        )
        .required(),
      flag: Joi.number()
        .allow(0, 1)
        .description(`0 - Token is not flagged, 1 - Token is flagged`)
        .required(),
    }),
  },
  response: {
    schema: Joi.object({
      message: Joi.string(),
    }).label(`postFlagToken${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`post-flag-token-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const payload = request.payload as any;
    const [contract, tokenId] = payload.token.split(":");

    const token = await Tokens.getByContractAndTokenId(contract, tokenId);

    if (!token) {
      throw Boom.badData(`Token ${payload.token} not found`);
    }

    try {
      const currentUtcTime = new Date().toISOString();
      const fields: TokensEntityUpdateParams = {
        isFlagged: payload.flag,
        lastFlagUpdate: currentUtcTime,
      };

      // If current flag status is different trigger a job to verify the new status
      if (token.isFlagged != payload.flag) {
        fields.lastFlagChange = currentUtcTime;

        const collection = await Collections.getByContractAndTokenId(contract, tokenId);

        await metadataIndexFetch.addToQueue(
          [
            {
              kind: "single-token",
              data: {
                method: metadataIndexFetch.getIndexingMethod(collection?.community || null),
                contract,
                tokenId,
                collection: token.collectionId,
              },
            },
          ],
          true
        );
      }

      // Update the token status
      await Tokens.update(contract, tokenId, fields);

      const key = request.headers["x-api-key"];
      const apiKey = await ApiKeyManager.getApiKey(key);

      const remoteAddress = request.headers["x-forwarded-for"]
        ? _.split(request.headers["x-forwarded-for"], ",")[0]
        : request.info.remoteAddress;

      const callingUser =
        _.isUndefined(key) || _.isEmpty(key) || _.isNull(apiKey) ? remoteAddress : apiKey.appName; // If no api key or the api key is invalid use IP

      logger.info(
        `post-flag-token-${version}-handler`,
        `${callingUser} updated ${payload.token} to ${payload.flag} from ${token.isFlagged}`
      );
      return { message: "Request accepted" };
    } catch (error) {
      logger.error(`post-flag-token-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
