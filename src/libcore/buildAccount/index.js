// @flow

import last from "lodash/last";
import {
  encodeAccountId,
  getAccountPlaceholderName,
  getNewAccountPlaceholderName
} from "../../account";
import type { Account, CryptoCurrency, DerivationMode } from "../../types";
import { libcoreAmountToBigNumber } from "../buildBigNumber";
import { buildOperation } from "./buildOperation";
import { buildTokenAccounts } from "./buildTokenAccounts";
import { minimalOperationsBuilder } from "../../reconciliation";
import { BigNumber } from "bignumber.js";
import { runDerivationScheme, getDerivationScheme, cutDerivationSchemeAfterAccount } from "../../derivation";
var core_messages = require('../messages/commands_pb.js');
var bitcoin_messages = require('../messages/bitcoin/commands_pb.js');

export async function buildAccount({
  core,
  coreAccountId,
  coreOperations,
  currency,
  accountIndex,
  derivationMode,
  existingAccount
}: {
  core: any,
  coreAccountId: any,
  coreOperations: any[],
  currency: CryptoCurrency,
  accountIndex: number,
  derivationMode: DerivationMode,
  existingAccount: ?Account
}): Promise<Account> {
  //get balance
  var getBalanceReq = new bitcoin_messages.GetBalanceRequest();
  getBalanceReq.setAccountId(coreAccountId)
  var bitcoinRequest = new bitcoin_messages.BitcoinRequest();
  bitcoinRequest.setGetBalance(getBalanceReq);
  var req = new core_messages.CoreRequest();
  req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
  req.setRequestBody(bitcoinRequest.serializeBinary());

  var resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
  if (resp.getError()) throw resp.getError();
  var getBalanceResponse = bitcoin_messages.GetBalanceResponse.deserializeBinary(resp.getResponseBody());
  const balance = BigNumber(getBalanceResponse.getAmount().getValue());

  //get last block
  var getLastBlockReq = new bitcoin_messages.GetLastBlockRequest();
  getLastBlockReq.setAccountId(coreAccountId)
  bitcoinRequest = new bitcoin_messages.BitcoinRequest();
  bitcoinRequest.setGetBalance(getLastBlockReq);
  req = new core_messages.CoreRequest();
  req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
  req.setRequestBody(bitcoinRequest.serializeBinary());

  resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
  if (resp.getError()) throw resp.getError();
  var getLastBlockResp = bitcoin_messages.GetLastBlockResponse.deserializeBinary(resp.getResponseBody());
  
  const blockHeight = getLastBlockResp.getLastBlock().getHeight();
  // get fresh address
  var getFreshAddressReq = new bitcoin_messages.GetFreshAddressRequest();
  getFreshAddressReq.setAccountId(coreAccountId)
  bitcoinRequest = new bitcoin_messages.BitcoinRequest();
  bitcoinRequest.setGetFreshAddress(getFreshAddressReq);
  req = new core_messages.CoreRequest();
  req.setRequestType(core_messages.CoreRequestType.BITCOIN_REQUEST);
  req.setRequestBody(bitcoinRequest.serializeBinary());

  resp = core_messages.CoreResponse.deserializeBinary(await core.sendRequest(req.serializeBinary()));
  if (resp.getError()) throw resp.getError();
  var getFreshAddressResp = bitcoin_messages.GetFreshAddressResponse.deserializeBinary(resp.getResponseBody());
  
  if ((getFreshAddressResp.getAddress() === "") || 
      (getFreshAddressResp.getPath() === ""))
    throw new Error("Can't get fresh address from lib-core");
  const accountPath = runDerivationScheme(
    cutDerivationSchemeAfterAccount(getDerivationScheme({derivationMode, currency})),
    {coinType: currency.coinType },
    {account: accountIndex });
  const freshAddress = {
    str: getFreshAddressResp.getAddress(),
    path: (getFreshAddressResp.getPath() === "")? accountPath : `${accountPath}/${getFreshAddressResp.getPath()}`
  };
  const name =
    coreOperations.length === 0
      ? getNewAccountPlaceholderName({
          currency,
          index: accountIndex,
          derivationMode
        })
      : getAccountPlaceholderName({
          currency,
          index: accountIndex,
          derivationMode
        });
  
  // retrieve xpub
  const xpub = coreAccountId.getXpub();

  const accountId = encodeAccountId({
    type: "libcore",
    version: "1",
    currencyId: currency.id,
    xpubOrAddress: xpub,
    derivationMode
  });
  const tokenAccounts = await buildTokenAccounts({
    currency,
    accountId,
    existingAccount
  });

  const operations = await minimalOperationsBuilder(
    (existingAccount && existingAccount.operations) || [],
    coreOperations,
    coreOperation =>
      buildOperation({
        coreOperation,
        accountId,
        currency,
        contextualTokenAccounts: tokenAccounts
      })
  );

  const account: $Exact<Account> = {
    type: "Account",
    id: accountId,
    seedIdentifier: xpub,
    xpub,
    derivationMode,
    index: accountIndex,
    freshAddress: freshAddress.address,
    freshAddressPath: freshAddress.derivationPath,
    freshAddresses: [],
    name,
    balance,
    blockHeight,
    currency,
    unit: currency.units[0],
    operations,
    pendingOperations: [],
    lastSyncDate: new Date()
  };

  if (tokenAccounts) {
    account.tokenAccounts = tokenAccounts;
  }

  return account;
}
