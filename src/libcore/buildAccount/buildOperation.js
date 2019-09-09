// @flow

import type { Operation, CryptoCurrency, TokenAccount } from "../../types";
import { inferSubOperations } from "../../account";
import type { CoreOperation } from "../types";
import perFamily from "../../generated/libcore-buildOperation";
import { BigNumber } from "bignumber.js";
var bitcoin_operation = require('../messages/bitcoin/operation_pb');

export const OperationTypeMap = {
  "0": "OUT",
  "1": "IN"
};

export async function buildOperation(arg: {
  coreOperation: any,
  accountId: string,
  currency: CryptoCurrency,
  contextualTokenAccounts?: ?(TokenAccount[])
}) {
  const { coreOperation, accountId, currency, contextualTokenAccounts } = arg;
  const buildOp = perFamily[currency.family];
  if (!buildOp) {
    throw new Error(currency.family + " family not supported");
  }

  var type = "NONE";
  if (coreOperation.getOperationType() === bitcoin_operation.Operation.OperationType.SEND) {
    type = "OUT";
  }
  else if (coreOperation.getOperationType() === bitcoin_operation.Operation.OperationType.RECEIVE) {
    type = "IN";
  }

  var value = BigNumber(coreOperation.getAmount().getValue());
  
  if (!coreOperation.getFee())
    throw new Error("fees should not be null");
  const fee = BigNumber(coreOperation.getFee().getValue());

  if (type === "OUT") {
    value = value.plus(fee);
  }

  const recipients = coreOperation.getReceiversList();
  const senders = coreOperation.getSendersList();
  
  const date = new Date(coreOperation.getDateEpochMs());

  const partialOp = {
    type,
    value,
    fee,
    senders,
    recipients,
    blockHeight: coreOperation.getBlockHeight(),
    blockHash: null,
    accountId,
    date,
    extra: {}
  };

  const rest = await buildOp(arg, partialOp);
  if (!rest) return null;
  const id = `${accountId}-${rest.hash}-${type}`;

  const op: $Exact<Operation> = {
    id,
    subOperations: contextualTokenAccounts
      ? inferSubOperations(rest.hash, contextualTokenAccounts)
      : undefined,
    ...partialOp,
    ...rest
  };

  return op;
}
