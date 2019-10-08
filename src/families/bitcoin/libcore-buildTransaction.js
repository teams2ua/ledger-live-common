// @flow

import { BigNumber } from "bignumber.js";
import { FeeNotLoaded, InvalidAddress } from "@ledgerhq/errors";
import type { Account, Transaction } from "../../types";
import type { Core, CoreCurrency, CoreAccount } from "../../libcore/types";
import type { CoreBitcoinLikeTransaction } from "./types";
var core_messages = require('../../libcore/messages/commands_pb');
var bitcoin_messages = require('../../libcore/messages/bitcoin/commands_pb.js');
var core_bitcoin_transaction = require('../../libcore/messages/bitcoin/transaction_pb.js');

async function bitcoinBuildWipeAllTransaction({
  core,
  coreAccountId,
  feePerByte,
  recipient
}: {
  core: Core,
  coreAccountId: any, 
  feePerByte: any,
  recipient: String
}): Promise<?any> {
  var wipeToAddressRequest = new bitcoin_messages.BuildWipeToAddressTransactionRequest();
  wipeToAddressRequest.setAccountId(coreAccountId);
  wipeToAddressRequest.setRecipient(recipient);
  wipeToAddressRequest.setFeesPerByte(feePerByte.toString());
  var bitcoinRequest = new bitcoin_messages.BitcoinRequest();
  bitcoinRequest.setBuildWipeTransaction(wipeToAddressRequest);
  var req = new core_messages.CoreRequest();
  req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
  req.setRequestBody(bitcoinRequest.serializeBinary());
  
  var resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
  if (resp.getError()) throw resp.getError();
  return core_bitcoin_transaction.Transaction.deserializeBinary(resp.getResponseBody());
}

async function bitcoinBuildTransactionWithAmount({
  core,
  coreAccountId,
  feePerByte,
  recipient,
  amount
}: {
  core: Core,
  coreAccountId: any, 
  feePerByte: any,
  recipient: String,
  amount: any
}): Promise<?any> {
  var buildTransactionRequest = new bitcoin_messages.BuildTransactionRequest();
  buildTransactionRequest.setAccountId(coreAccountId);
  buildTransactionRequest.setFeesPerByte(feePerByte.toString());
  
  var recipientAddress = new bitcoin_messages.RecipientAndAmount();
  recipientAddress.setRecipient(recipient);
  recipientAddress.setAmount(amount);

  var bitcoinRequest = new bitcoin_messages.BitcoinRequest();
  bitcoinRequest.set(buildTransactionRequest);
  var req = new core_messages.CoreRequest();
  req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
  req.setRequestBody(bitcoinRequest.serializeBinary());
  
  var resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
  if (resp.getError()) throw resp.getError();
  return core_bitcoin_transaction.Transaction.deserializeBinary(resp.getResponseBody());
}

async function bitcoinBuildTransaction({
  account,
  core,
  transaction,
  isPartial,
  isCancelled
}: {
  account: Account,
  core: Core,
  transaction: Transaction,
  isPartial: boolean,
  isCancelled: () => boolean
}): Promise<?any> {
  
  var isValidAddressRequest = new bitcoin_messages.IsAddressValidRequest();
  isValidAddressRequest.setCurrencyName(account.currency.name.toLowerCase());
  isValidAddressRequest.setAddress(transaction.recipient);
  var bitcoinRequest = new bitcoin_messages.BitcoinRequest();
  bitcoinRequest.setIsAddressValid(isValidAddressRequest);
  var req = new core_messages.CoreRequest();
  req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
  req.setRequestBody(bitcoinRequest.serializeBinary());
  
  var resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
  if (resp.getError()) throw resp.getError();

  var isValidResponse = bitcoin_messages.IsAddressValidResponse.deserializeBinary(resp.getResponseBody());
  const isValid = isValidResponse.getIsValid();

  if (!isValid) {
    throw new InvalidAddress("", { currencyName: account.currency.name });
  }

  const { feePerByte } = transaction;
  if (!feePerByte) throw new FeeNotLoaded();

  if (isCancelled()) return;
  
  if (transaction.useAllAmount) {
    return bitcoinBuildWipeAllTransaction(core, feePerByte, transaction.recipient);
  } else {
    if (!transaction.amount) throw new Error("amount is missing");
    const amount = transaction.amount;
    if (isCancelled()) return;
    return bitcoinBuildTransactionWithAmount(core, feePerByte, amount, transaction.recipient);
  }
}

export default bitcoinBuildTransaction;
